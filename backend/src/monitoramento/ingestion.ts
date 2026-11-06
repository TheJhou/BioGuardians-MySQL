import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { execute, query, withTransaction } from '../db/pool.js';
import { logger } from '../telemetry/logger.js';
import { parseInpeCsv, type InpeFireEvent } from './inpe.js';

interface SourceRow extends RowDataPacket {
  id: number;
  codigo: string;
  formato: string;
  endpoint: string;
  ativo: number;
}

interface ImportOptions {
  sourceCode: string;
  date?: string;
  file?: string;
  limit?: number;
  dryRun?: boolean;
}

export interface ImportSummary {
  source: string;
  executionId: number | null;
  rowsRead: number;
  validEvents: number;
  inserted: number;
  updated: number;
  ignored: number;
  rejected: number;
  rejectionReasons: Record<string, number>;
  checksum: string;
  dryRun: boolean;
}

interface ReferenceMaps {
  biomas: Map<string, number>;
  estados: Map<string, string>;
}

interface PreparedEvent extends InpeFireEvent {
  biomaId: number | null;
  estadoUf: string | null;
}

const BATCH_SIZE = 200;
const HTTP_TIMEOUT_MS = 45_000;

function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function validDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('A data deve usar o formato YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('Data inválida');
  }
  return value;
}

function dateToken(value: string): string {
  return value.replaceAll('-', '');
}

async function getSource(code: string): Promise<SourceRow> {
  const { rows } = await query<SourceRow>(
    'SELECT id, codigo, formato, endpoint, ativo FROM monitor_fonte WHERE codigo = ? LIMIT 1',
    [code]
  );
  const source = rows[0];
  if (!source) throw new Error(`Fonte não encontrada no catálogo: ${code}`);
  if (source.formato !== 'csv') throw new Error(`A fonte ${code} não usa CSV`);
  return source;
}

async function loadText(options: ImportOptions, endpoint: string): Promise<string> {
  if (options.file) return readFile(options.file, 'utf8');

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (!response.ok) {
        const error = new Error(`INPE respondeu HTTP ${response.status}`) as Error & { permanent?: boolean };
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          error.permanent = true;
          throw error;
        }
        lastError = error;
      } else {
        return await response.text();
      }
    } catch (error) {
      if ((error as { permanent?: boolean })?.permanent) throw error;
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** (attempt - 1))));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function loadReferences(): Promise<ReferenceMaps> {
  const [biomas, estados] = await Promise.all([
    query<{ id: number; nome: string }>('SELECT id, nome FROM bioma'),
    query<{ uf: string; nome: string }>('SELECT uf, nome FROM estado'),
  ]);
  return {
    biomas: new Map(biomas.rows.map((row) => [normalizeName(row.nome), row.id])),
    estados: new Map(estados.rows.flatMap((row) => [[normalizeName(row.nome), row.uf], [normalizeName(row.uf), row.uf]])),
  };
}

function prepareEvents(events: InpeFireEvent[], refs: ReferenceMaps): { events: PreparedEvent[]; rejected: number } {
  let rejected = 0;
  const prepared = events.flatMap((event) => {
    if ((event.riscoFogo !== null && event.riscoFogo < 0) || (event.frpMw !== null && event.frpMw < 0)) {
      rejected += 1;
      return [];
    }
    return [{
      ...event,
      biomaId: event.biomaNome ? refs.biomas.get(normalizeName(event.biomaNome)) ?? null : null,
      estadoUf: event.estadoNome ? refs.estados.get(normalizeName(event.estadoNome)) ?? null : null,
    }];
  });
  return { events: prepared, rejected };
}

function placeholders(count: number, item: string): string {
  return Array.from({ length: count }, () => item).join(', ');
}

async function persistBatch(sourceId: number, executionId: number, events: PreparedEvent[]): Promise<{ inserted: number; updated: number }> {
  if (events.length === 0) return { inserted: 0, updated: 0 };

  return withTransaction(async (conn) => {
    const externalIds = events.map((event) => event.idExterno);
    const [existingRows] = await conn.query<RowDataPacket[]>(
      'SELECT id_externo FROM monitor_evento WHERE fonte_id = ? AND id_externo IN (?)',
      [sourceId, externalIds]
    );
    const existing = new Set(existingRows.map((row) => String(row.id_externo)));

    const valuesSql = placeholders(events.length, '(?, ?, ?, ?, ST_SRID(POINT(?, ?), 4326), ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))');
    const params = events.flatMap((event) => [
      sourceId,
      executionId,
      'foco_calor',
      event.idExterno,
      event.longitude,
      event.latitude,
      event.dataObservacao,
      event.precisaoData,
      event.biomaId,
      event.estadoUf,
      event.municipioNome,
      event.municipioCodigoIbge,
      event.satelite,
      event.riscoFogo,
      event.frpMw,
      JSON.stringify(event.propriedadesOrigem),
    ]);
    const sql = `INSERT INTO monitor_evento (
        fonte_id, ultima_execucao_id, tipo_evento_codigo, id_externo, geom,
        data_observacao, precisao_data, bioma_id, estado_uf, municipio_nome,
        municipio_codigo_ibge, satelite, risco_fogo, frp_mw, propriedades_origem
      ) VALUES ${valuesSql}
      ON DUPLICATE KEY UPDATE
        ultima_execucao_id = VALUES(ultima_execucao_id),
        geom = VALUES(geom),
        data_observacao = VALUES(data_observacao),
        precisao_data = VALUES(precisao_data),
        bioma_id = VALUES(bioma_id),
        estado_uf = VALUES(estado_uf),
        municipio_nome = VALUES(municipio_nome),
        municipio_codigo_ibge = VALUES(municipio_codigo_ibge),
        satelite = VALUES(satelite),
        risco_fogo = VALUES(risco_fogo),
        frp_mw = VALUES(frp_mw),
        propriedades_origem = VALUES(propriedades_origem),
        ultima_vista_em = UTC_TIMESTAMP(6)`;
    await conn.execute<ResultSetHeader>(sql, params);

    const [eventRows] = await conn.query<RowDataPacket[]>(
      'SELECT id, id_externo FROM monitor_evento WHERE fonte_id = ? AND id_externo IN (?)',
      [sourceId, externalIds]
    );
    const eventIds = eventRows.map((row) => Number(row.id));
    if (eventIds.length > 0) {
      const [attendanceRows] = await conn.query<RowDataPacket[]>(
        'SELECT evento_id FROM monitor_atendimento WHERE evento_id IN (?)',
        [eventIds]
      );
      const existingAttendance = new Set(attendanceRows.map((row) => Number(row.evento_id)));
      await conn.query(
        `INSERT IGNORE INTO monitor_atendimento (evento_id, status)
         VALUES ${placeholders(eventIds.length, "(?, 'novo')")}`,
        eventIds
      );
      const newAttendanceIds = eventIds.filter((id) => !existingAttendance.has(id));
      if (newAttendanceIds.length > 0) {
        const historyParams = newAttendanceIds.flatMap((id) => [id, 'Atendimento inicial criado na importação do INPE.']);
        await conn.query(
          `INSERT INTO monitor_atendimento_historico
             (evento_id, status_anterior, status_novo, ator, observacao)
           VALUES ${placeholders(newAttendanceIds.length, "(?, NULL, 'novo', 'sistema', ?)")}`,
          historyParams
        );
      }

      await conn.query('DELETE FROM monitor_evento_uc WHERE evento_id IN (?)', [eventIds]);
      await conn.query(
        `INSERT INTO monitor_evento_uc (evento_id, area_id, tipo_relacao)
         SELECT e.id, a.id, 'contem_ponto'
         FROM monitor_evento e
         JOIN area_protegida a
           ON MBRIntersects(a.geom, e.geom) AND ST_Contains(a.geom, e.geom)
         WHERE e.id IN (?)`,
        [eventIds]
      );
    }

    const updated = events.filter((event) => existing.has(event.idExterno)).length;
    return { inserted: events.length - updated, updated };
  });
}

async function finishExecution(
  executionId: number,
  result: Pick<ImportSummary, 'rowsRead' | 'inserted' | 'updated' | 'ignored' | 'rejected' | 'checksum'>,
  parameters: Record<string, unknown>,
  error: string | null
): Promise<void> {
  const status = error ? 'erro' : result.rejected > 0 ? 'parcial' : 'concluida';
  await execute(
    `UPDATE monitor_execucao
     SET status = ?, concluida_em = UTC_TIMESTAMP(6), registros_lidos = ?,
         registros_novos = ?, registros_atualizados = ?, registros_ignorados = ?,
         registros_rejeitados = ?, parametros = CAST(? AS JSON), checksum_arquivo = ?, erro = ?
     WHERE id = ?`,
    [status, result.rowsRead, result.inserted, result.updated, result.ignored, result.rejected,
      JSON.stringify(parameters), result.checksum || null,
      error?.slice(0, 6000) ?? null, executionId]
  );
}

export async function importInpeCsv(options: ImportOptions): Promise<ImportSummary> {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100_000)) {
    throw new Error('--limit deve ser um inteiro entre 1 e 100000');
  }
  const date = validDate(options.date ?? new Date().toISOString().slice(0, 10));
  const source = await getSource(options.sourceCode);
  const endpoint = source.endpoint.replace('{yyyymmdd}', dateToken(date));
  if (!options.file && endpoint.includes('{')) throw new Error(`Endpoint da fonte tem marcador não resolvido: ${source.codigo}`);

  const executionParams = {
    tipo: 'csv',
    fonte: source.codigo,
    data: date,
    arquivo: options.file ? basename(options.file) : null,
    limite: options.limit ?? null,
  };
  let executionId: number | null = null;
  if (!options.dryRun) {
    const created = await execute(
      `INSERT INTO monitor_execucao (fonte_id, status, janela_inicio, janela_fim, parametros)
       VALUES (?, 'em_execucao', ?, ?, CAST(? AS JSON))`,
      [source.id, `${date} 00:00:00`, `${date} 23:59:59`, JSON.stringify(executionParams)]
    );
    executionId = created.insertId;
  }

  let summary: ImportSummary = {
    source: source.codigo,
    executionId,
    rowsRead: 0,
    validEvents: 0,
    inserted: 0,
    updated: 0,
    ignored: 0,
    rejected: 0,
    rejectionReasons: {},
    checksum: '',
    dryRun: options.dryRun ?? false,
  };

  try {
    const csv = await loadText(options, endpoint);
    summary.checksum = createHash('sha256').update(csv).digest('hex');
    const parsed = parseInpeCsv(csv, options.limit);
    summary.rowsRead = parsed.rowsRead;
    summary.ignored = parsed.duplicatedInFile;
    summary.rejectionReasons = { ...parsed.rejected };
    summary.rejected = Object.values(parsed.rejected).reduce((total, count) => total + count, 0);

    const refs = await loadReferences();
    const prepared = prepareEvents(parsed.events, refs);
    summary.validEvents = prepared.events.length;
    if (prepared.rejected > 0) {
      summary.rejected += prepared.rejected;
      summary.rejectionReasons.valor_negativo = prepared.rejected;
    }
    if (!summary.dryRun && executionId !== null) {
      for (let offset = 0; offset < prepared.events.length; offset += BATCH_SIZE) {
        const result = await persistBatch(source.id, executionId, prepared.events.slice(offset, offset + BATCH_SIZE));
        summary.inserted += result.inserted;
        summary.updated += result.updated;
      }
      await finishExecution(executionId, summary, { ...executionParams, rejeicoes_por_motivo: summary.rejectionReasons }, null);
    }

    logger.info('monitor_inpe_import_complete', {
      source: source.codigo,
      execution_id: executionId,
      rows_read: summary.rowsRead,
      inserted: summary.inserted,
      updated: summary.updated,
      ignored: summary.ignored,
      rejected: summary.rejected,
      dry_run: summary.dryRun,
      checksum: summary.checksum,
    });
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (executionId !== null) {
      await finishExecution(executionId, summary, { ...executionParams, rejeicoes_por_motivo: summary.rejectionReasons }, message).catch((finishError) => {
        logger.error('monitor_execution_finalize_failed', {
          execution_id: executionId,
          error: finishError instanceof Error ? finishError.message : String(finishError),
        });
      });
    }
    throw error;
  }
}
