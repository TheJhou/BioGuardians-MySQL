import { createHash } from 'node:crypto';
import { parseCsv } from './csv.js';

export interface InpeFireEvent {
  idExterno: string;
  longitude: number;
  latitude: number;
  dataObservacao: string | null;
  precisaoData: 'instante' | 'dia' | 'desconhecida';
  municipioNome: string | null;
  municipioCodigoIbge: string | null;
  estadoNome: string | null;
  biomaNome: string | null;
  satelite: string | null;
  riscoFogo: number | null;
  frpMw: number | null;
  propriedadesOrigem: Record<string, string>;
}

export interface InpeParseResult {
  events: InpeFireEvent[];
  rowsRead: number;
  rejected: Record<string, number>;
  duplicatedInFile: number;
}

function normalizeHeader(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pick(row: Record<string, string>, aliases: string[]): string | null {
  const values = new Map(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
  for (const alias of aliases) {
    const value = values.get(alias);
    if (value !== undefined && value !== '') return value;
  }
  return null;
}

function parseNumber(value: string | null): number | null {
  if (value === null) return null;
  const clean = value.trim().replace(/\s/g, '');
  const normalized = clean.includes(',') && !clean.includes('.') ? clean.replace(',', '.') : clean.replace(/,/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseObservedAt(value: string | null): { value: string | null; precision: InpeFireEvent['precisaoData'] } {
  if (!value) return { value: null, precision: 'desconhecida' };

  const match = value.trim().match(/^(\d{4})[/-](\d{2})[/-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const [, year, month, day, hour, minute, second] = match;
    if (Number(hour ?? 0) > 23 || Number(minute ?? 0) > 59 || Number(second ?? 0) > 59) {
      return { value: null, precision: 'desconhecida' };
    }
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour || 0), Number(minute || 0), Number(second || 0)));
    if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) {
      return { value: null, precision: 'desconhecida' };
    }
    const precision = hour ? 'instante' : 'dia';
    if (!hour) date.setUTCHours(0, 0, 0, 0);
    return { value: date.toISOString().slice(0, 19).replace('T', ' '), precision };
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { value: null, precision: 'desconhecida' };
  return { value: parsed.toISOString().slice(0, 19).replace('T', ' '), precision: 'instante' };
}

function stableId(row: Record<string, string>, date: string | null, latitude: number, longitude: number, satellite: string | null): string {
  const sourceId = pick(row, ['id', 'idregistro', 'identificador']);
  if (sourceId) return sourceId.slice(0, 255);
  const identity = [date ?? '', latitude.toFixed(6), longitude.toFixed(6), satellite ?? ''].join('|');
  return `sha256:${createHash('sha256').update(identity).digest('hex')}`;
}

export function parseInpeCsv(text: string, limit?: number): InpeParseResult {
  const { headers, rows } = parseCsv(text);
  const headerNames = new Set(headers.map(normalizeHeader));
  if (!headerNames.has('latitude') && !headerNames.has('lat')) throw new Error('CSV do INPE sem coluna Latitude');
  if (!headerNames.has('longitude') && !headerNames.has('long') && !headerNames.has('lon')) {
    throw new Error('CSV do INPE sem coluna Longitude');
  }
  const selectedRows = limit ? rows.slice(0, limit) : rows;

  const events = new Map<string, InpeFireEvent>();
  const rejected: Record<string, number> = {};
  let duplicatedInFile = 0;
  const reject = (reason: string) => { rejected[reason] = (rejected[reason] ?? 0) + 1; };

  for (const row of selectedRows) {
    const latitude = parseNumber(pick(row, ['latitude', 'lat']));
    const longitude = parseNumber(pick(row, ['longitude', 'long', 'lon']));
    if (latitude === null || longitude === null) {
      reject('coordenada_ausente_ou_invalida');
      continue;
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      reject('coordenada_fora_do_intervalo');
      continue;
    }

    const dateRaw = pick(row, ['datahora', 'datahoragmt', 'datetime', 'data']);
    const observed = parseObservedAt(dateRaw);
    if (dateRaw && observed.value === null) {
      reject('data_invalida');
      continue;
    }
    const satellite = pick(row, ['satelite', 'satellite']);
    const event: InpeFireEvent = {
      idExterno: stableId(row, observed.value, latitude, longitude, satellite),
      longitude,
      latitude,
      dataObservacao: observed.value,
      precisaoData: observed.precision,
      municipioNome: pick(row, ['municipio', 'municipi', 'municipio_nome']),
      municipioCodigoIbge: (() => {
        const code = pick(row, ['municipioid', 'municipiocodigoibge', 'codigomunicipioibge']);
        return code && /^\d{7}$/.test(code) ? code : null;
      })(),
      estadoNome: pick(row, ['estado', 'uf']),
      biomaNome: pick(row, ['bioma']),
      satelite: satellite,
      riscoFogo: parseNumber(pick(row, ['riscofogo', 'risco_fogo'])),
      frpMw: parseNumber(pick(row, ['frp', 'frpmw'])),
      propriedadesOrigem: row,
    };
    if (events.has(event.idExterno)) duplicatedInFile += 1;
    events.set(event.idExterno, event);
  }

  return { events: [...events.values()], rowsRead: selectedRows.length, rejected, duplicatedInFile };
}
