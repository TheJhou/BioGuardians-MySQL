import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { pool, query } from '../db/pool.js';
import { logger } from '../telemetry/logger.js';
import { importMonitorSource } from './runner.js';

interface DueSource extends RowDataPacket {
  codigo: string;
  formato: string;
  frequencia_minutos: number | null;
  ultimo_status: string | null;
  ultima_execucao: Date | string | null;
}

const LOCK_NAME = 'bioguardians_monitor_worker';
const POLL_MS = 60_000;
let stopping = false;
let tickRunning = false;
let lockConnection: PoolConnection | null = null;

function elapsedMinutes(value: Date | string): number {
  const time = value instanceof Date ? value.getTime() : new Date(`${value.replace(' ', 'T')}Z`).getTime();
  return (Date.now() - time) / 60_000;
}

async function runDueSources(): Promise<void> {
  if (tickRunning || stopping) return;
  tickRunning = true;
  try {
    const { rows } = await query<DueSource>(
      `SELECT f.codigo, f.formato, f.frequencia_minutos,
              latest.status AS ultimo_status, latest.iniciada_em AS ultima_execucao
       FROM monitor_fonte f
       LEFT JOIN monitor_execucao latest ON latest.id = (
         SELECT MAX(e.id) FROM monitor_execucao e WHERE e.fonte_id = f.id
       )
       WHERE f.ativo = TRUE
       ORDER BY f.id`
    );

    for (const source of rows) {
      if (stopping) break;
      const interval = Math.max(1, Number(source.frequencia_minutos ?? 60));
      const retryInterval = Math.min(interval, 15);
      const requiredInterval = source.ultimo_status === 'erro' || source.ultimo_status === 'em_execucao'
        ? retryInterval
        : interval;
      if (source.ultima_execucao && elapsedMinutes(source.ultima_execucao) < requiredInterval) continue;

      if (source.formato !== 'csv' && source.formato !== 'wfs') {
        logger.warn('monitor_source_adapter_unavailable', { source: source.codigo, format: source.formato });
        continue;
      }

      try {
        await importMonitorSource({ sourceCode: source.codigo });
      } catch (error) {
        logger.error('monitor_source_import_failed', {
          source: source.codigo,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    tickRunning = false;
  }
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  while (tickRunning) await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    if (lockConnection) {
      await lockConnection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
      lockConnection.release();
      lockConnection = null;
    }
  } catch (error) {
    logger.warn('monitor_worker_lock_release_failed', { error: error instanceof Error ? error.message : String(error) });
  }
  await pool.end();
}

async function main(): Promise<void> {
  lockConnection = await pool.getConnection();
  const [rows] = await lockConnection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS acquired', [LOCK_NAME]);
  if (Number(rows[0]?.acquired) !== 1) {
    lockConnection.release();
    lockConnection = null;
    throw new Error('Já existe outro monitor-worker ativo');
  }

  logger.info('monitor_worker_started', { poll_ms: POLL_MS });
  await runDueSources();
  const timer = setInterval(() => void runDueSources(), POLL_MS);
  timer.unref();

  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch(async (error) => {
  logger.error('monitor_worker_start_failed', { error: error instanceof Error ? error.message : String(error) });
  await pool.end();
  process.exitCode = 1;
});
