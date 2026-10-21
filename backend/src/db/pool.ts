import mysql from 'mysql2/promise';
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { trace } from '@opentelemetry/api';
import { env } from '../config/env.js';
import { logger } from '../telemetry/logger.js';
import { dbOperationDuration } from '../telemetry/metrics.js';

const MAX_SQL_LOG_LEN = 500;

// Primeira palavra do SQL (SELECT, INSERT, ...) para o label db_operation.
function sqlOperation(text: string): string {
  return text.trimStart().split(/\s/, 1)[0].toUpperCase();
}

function getTraceId(): string | undefined {
  return trace.getActiveSpan()?.spanContext().traceId;
}

function summarizeSql(text: string): string {
  return text.length > MAX_SQL_LOG_LEN ? text.slice(0, MAX_SQL_LOG_LEN) + '...' : text;
}

export const pool = mysql.createPool({
  uri: env.databaseUrl,
  connectionLimit: env.dbPoolMax,
  maxIdle: env.dbPoolMax,
  connectTimeout: 10_000,
  idleTimeout: 30_000,
  // utf8mb4 na conexão. O handshake só aceita colação com id <= 255, então
  // não dá para usar a do banco (utf8mb4_0900_as_cs = 278). Não muda o
  // resultado: comparando coluna com parâmetro, vale a colação da coluna.
  charset: 'UTF8MB4_0900_AI_CI',
  // DECIMAL/SUM/AVG como number (o frontend já tipa esses campos como number).
  decimalNumbers: true,
  // DATE como 'YYYY-MM-DD' (sem fuso); DATETIME em UTC, igual ao servidor.
  dateStrings: ['DATE'],
  timezone: 'Z',
});

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

// Placeholders são "?" (posicionais). Arrays viram listas: "IN (?)" com [1, 2, 3].
export async function query<T = any>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const traceId = getTraceId();
  const paramsCount = params?.length ?? 0;

  try {
    const [result] = await pool.query<RowDataPacket[] | ResultSetHeader>(text, params);
    const duration_ms = Date.now() - start;
    const rows = (Array.isArray(result) ? result : []) as T[];
    const rowCount = Array.isArray(result) ? result.length : result.affectedRows;

    dbOperationDuration.record(duration_ms / 1000, { 'db.operation': sqlOperation(text) });
    logger.info('db_query', {
      duration_ms,
      rows: rowCount,
      params_count: paramsCount,
      sql: summarizeSql(text),
      ...(traceId ? { trace_id: traceId } : {}),
    });

    return { rows, rowCount };
  } catch (err) {
    const duration_ms = Date.now() - start;

    logger.error('db_query_failed', {
      duration_ms,
      params_count: paramsCount,
      sql: summarizeSql(text),
      error: err instanceof Error ? err.message : String(err),
      ...(traceId ? { trace_id: traceId } : {}),
    });

    throw err;
  }
}

export async function withTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
