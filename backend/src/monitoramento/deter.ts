import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { FeatureCollection } from 'geojson';
import { execute } from '../db/pool.js';
import { logger } from '../telemetry/logger.js';
import {
  finishExecution,
  getSource,
  loadReferences,
  persistBatch,
  type ImportOptions,
  type ImportSummary,
} from './ingestion.js';
import { parseDeterFeatureCollection } from './deterParser.js';

type WfsFeatureCollection = FeatureCollection & {
  totalFeatures?: number | string;
  numberMatched?: number | string;
  numberReturned?: number | string;
  crs?: { type?: string; properties?: { name?: string } };
};

const WFS_PAGE_SIZE = 500;
const HTTP_TIMEOUT_MS = 90_000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 3650;
const MAX_FEATURE_LIMIT = 100_000;

function validDateOption(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('A data de início deve usar YYYY-MM-DD e ser uma data válida');
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('A data de início deve usar YYYY-MM-DD e ser uma data válida');
  }
  return value;
}

function defaultSince(windowDays: number): string {
  return new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
}

async function fetchWfsPage(
  source: { endpoint: string; camada_wfs: string },
  since: string,
  startIndex: number,
  count: number,
): Promise<{ text: string; collection: WfsFeatureCollection }> {
  const url = new URL(source.endpoint);
  const params: Record<string, string> = {
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: source.camada_wfs,
    srsName: 'EPSG:4326',
    outputFormat: 'application/json',
    CQL_FILTER: `view_date >= '${since}' AND gid LIKE '%curr'`,
    count: String(count),
    startIndex: String(startIndex),
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (!response.ok) {
        const error = new Error(`TerraBrasilis respondeu HTTP ${response.status}`) as Error & { permanent?: boolean };
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          error.permanent = true;
          throw error;
        }
        lastError = error;
      } else {
        const text = await response.text();
        return { text, collection: JSON.parse(text) as WfsFeatureCollection };
      }
    } catch (error) {
      if ((error as { permanent?: boolean })?.permanent) throw error;
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** (attempt - 1))));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function importDeterWfs(options: ImportOptions): Promise<ImportSummary> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > MAX_WINDOW_DAYS) {
    throw new Error(`--janela-dias deve ser um inteiro entre 1 e ${MAX_WINDOW_DAYS}`);
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_FEATURE_LIMIT)) {
    throw new Error(`--limit deve ser um inteiro entre 1 e ${MAX_FEATURE_LIMIT}`);
  }

  const source = await getSource(options.sourceCode, 'wfs');
  if (!source.camada_wfs) throw new Error(`A fonte ${source.codigo} não tem camada WFS configurada`);
  if (!options.file && source.ativo !== 1) throw new Error(`A fonte ${source.codigo} está inativa`);
  const since = validDateOption(options.since ?? defaultSince(windowDays));
  const today = new Date().toISOString().slice(0, 10);
  const executionParams = {
    tipo: 'wfs_geojson',
    fonte: source.codigo,
    camada_wfs: source.camada_wfs,
    crs_origem: source.crs_origem,
    crs_importacao: 'EPSG:4326',
    desde: since,
    arquivo: options.file ? basename(options.file) : null,
    limite: options.limit ?? null,
  };
  let executionId: number | null = null;
  if (!options.dryRun) {
    const created = await execute(
      `INSERT INTO monitor_execucao (fonte_id, status, janela_inicio, janela_fim, parametros)
       VALUES (?, 'em_execucao', ?, ?, CAST(? AS JSON))`,
      [source.id, `${since} 00:00:00`, `${today} 23:59:59`, JSON.stringify(executionParams)]
    );
    executionId = created.insertId;
  }

  const summary: ImportSummary = {
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
    const refs = await loadReferences();
    const hash = createHash('sha256');
    const seenIds = new Set<string>();
    let offset = 0;
    let totalMatched: number | null = null;
    let remainingLimit = options.limit ?? Number.POSITIVE_INFINITY;

    while (remainingLimit > 0) {
      let text: string;
      let collection: WfsFeatureCollection;
      if (options.file) {
        if (offset > 0) break;
        text = await readFile(options.file, 'utf8');
        collection = JSON.parse(text) as WfsFeatureCollection;
      } else {
        const page = await fetchWfsPage(source as typeof source & { camada_wfs: string }, since, offset, Math.min(WFS_PAGE_SIZE, remainingLimit));
        text = page.text;
        collection = page.collection;
      }
      hash.update(`${offset}\0${text}\0`);

      const parserLimit = Number.isFinite(remainingLimit) ? remainingLimit : undefined;
      const parsed = parseDeterFeatureCollection(JSON.stringify(collection), source.codigo, source.nome, refs, parserLimit);
      summary.rowsRead += parsed.rowsRead;
      summary.ignored += parsed.duplicatedInFile;
      for (const [reason, count] of Object.entries(parsed.rejected)) {
        summary.rejectionReasons[reason] = (summary.rejectionReasons[reason] ?? 0) + count;
        summary.rejected += count;
      }
      const uniquePageEvents = parsed.events.filter((event) => {
        if (seenIds.has(event.idExterno)) { summary.ignored += 1; return false; }
        seenIds.add(event.idExterno);
        return true;
      });
      summary.validEvents += uniquePageEvents.length;

      if (!summary.dryRun && executionId !== null) {
        for (let batch = 0; batch < uniquePageEvents.length; batch += 200) {
          const persisted = await persistBatch(source.id, executionId, uniquePageEvents.slice(batch, batch + 200));
          summary.inserted += persisted.inserted;
          summary.updated += persisted.updated;
        }
      }

      if (options.file) break;
      const pageCount = collection.features?.length ?? 0;
      if (pageCount === 0) break;
      const matched = Number(collection.numberMatched ?? collection.totalFeatures);
      if (Number.isFinite(matched)) totalMatched = matched;
      offset += pageCount;
      remainingLimit -= pageCount;
      if (pageCount < Math.min(WFS_PAGE_SIZE, options.limit ? Math.max(1, options.limit - (offset - pageCount)) : WFS_PAGE_SIZE)) break;
      if (totalMatched !== null && offset >= totalMatched) break;
    }

    summary.checksum = hash.digest('hex');
    if (!summary.dryRun && executionId !== null) {
      await finishExecution(executionId, summary, {
        ...executionParams,
        rejeicoes_por_motivo: summary.rejectionReasons,
      }, null);
    }
    logger.info('monitor_deter_import_complete', {
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
      await finishExecution(executionId, summary, {
        ...executionParams,
        rejeicoes_por_motivo: summary.rejectionReasons,
      }, message).catch((finishError) => {
        logger.error('monitor_execution_finalize_failed', {
          execution_id: executionId,
          error: finishError instanceof Error ? finishError.message : String(finishError),
        });
      });
    }
    throw error;
  }
}
