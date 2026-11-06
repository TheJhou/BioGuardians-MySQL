import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { NormalizedMonitorEvent, ReferenceMaps } from './types.js';

type DeterGeometry = Extract<Geometry, { type: 'Polygon' | 'MultiPolygon' }>;
type DeterFeature = Feature<DeterGeometry, Record<string, unknown>>;
type DeterFeatureCollection = FeatureCollection<DeterGeometry, Record<string, unknown>> & {
  crs?: { type?: string; properties?: { name?: string } };
};

export interface DeterParseResult {
  events: NormalizedMonitorEvent[];
  rowsRead: number;
  duplicatedInFile: number;
  rejected: Record<string, number>;
}

function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function pick(properties: Record<string, unknown>, names: string[]): string | null {
  const normalized = new Map(Object.entries(properties).map(([key, value]) => [normalizeName(key), value]));
  for (const name of names) {
    const value = normalized.get(normalizeName(name));
    if (value === undefined || value === null || String(value).trim() === '') continue;
    return String(value).trim();
  }
  return null;
}

function validDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function finitePosition(value: unknown): value is number[] {
  return Array.isArray(value) && value.length >= 2
    && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))
    && Number(value[0]) >= -180 && Number(value[0]) <= 180
    && Number(value[1]) >= -90 && Number(value[1]) <= 90;
}

function validPolygonCoordinates(coordinates: unknown): boolean {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return false;
  return coordinates.every((ring) => Array.isArray(ring)
    && ring.length >= 4
    && ring.every(finitePosition)
    && JSON.stringify(ring[0]) === JSON.stringify(ring[ring.length - 1]));
}

function validGeometry(value: unknown): value is DeterGeometry {
  if (!value || typeof value !== 'object') return false;
  const geometry = value as { type?: unknown; coordinates?: unknown };
  if (geometry.type === 'Polygon') return validPolygonCoordinates(geometry.coordinates);
  if (geometry.type === 'MultiPolygon') {
    return Array.isArray(geometry.coordinates)
      && geometry.coordinates.length > 0
      && geometry.coordinates.every(validPolygonCoordinates);
  }
  return false;
}

function sourceBiome(sourceCode: string): string {
  return sourceCode.includes('cerrado') ? 'cerrado' : 'amazonia';
}

function toEvent(
  feature: DeterFeature,
  sourceCode: string,
  sourceName: string,
  refs: ReferenceMaps,
): NormalizedMonitorEvent | null {
  const properties = feature.properties ?? {};
  const rawId = feature.id ?? pick(properties, ['gid', 'uuid', 'uid']);
  const idExterno = rawId === null || rawId === undefined ? '' : String(rawId).trim();
  const observedDate = validDate(pick(properties, ['view_date', 'date', 'data']));
  if (!idExterno || idExterno.length > 255 || !observedDate || !validGeometry(feature.geometry)) return null;

  const municipalityCode = pick(properties, ['mun_geocod', 'municipality_code', 'codigo_municipio']);
  const stateName = pick(properties, ['uf', 'state', 'estado']);
  const biomeName = sourceBiome(sourceCode);
  const className = pick(properties, ['classname', 'class_name', 'classe']);
  return {
    idExterno,
    geometry: feature.geometry,
    tipoEventoCodigo: 'alerta_deter',
    dataObservacao: `${observedDate} 00:00:00`,
    precisaoData: 'dia',
    biomaId: refs.biomas.get(normalizeName(biomeName)) ?? null,
    estadoUf: stateName ? refs.estados.get(normalizeName(stateName)) ?? null : null,
    municipioNome: pick(properties, ['municipality', 'municipio', 'municipality_name']),
    municipioCodigoIbge: municipalityCode && /^\d{7}$/.test(municipalityCode) ? municipalityCode : null,
    satelite: pick(properties, ['satellite', 'satelite']),
    riscoFogo: null,
    frpMw: null,
    classeFonte: className,
    propriedadesOrigem: properties,
    historicoInicial: `Atendimento inicial criado na importação TerraBrasilis DETER (${sourceName}).`,
  };
}

export function parseDeterFeatureCollection(
  text: string,
  sourceCode: string,
  sourceName: string,
  refs: ReferenceMaps,
  limit?: number,
): DeterParseResult {
  let payload: DeterFeatureCollection;
  try {
    payload = JSON.parse(text) as DeterFeatureCollection;
  } catch {
    throw new Error('Resposta WFS DETER não é JSON válido');
  }
  if (payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
    throw new Error('Resposta WFS DETER não é uma FeatureCollection GeoJSON');
  }
  const crsName = payload.crs?.properties?.name;
  if (crsName && !/(?:EPSG::?4326|EPSG:4326|CRS84)$/i.test(crsName)) {
    throw new Error(`O WFS DETER respondeu CRS não suportado: ${crsName}`);
  }

  const features = limit === undefined ? payload.features : payload.features.slice(0, limit);
  const events = new Map<string, NormalizedMonitorEvent>();
  const rejected: Record<string, number> = {};
  let duplicatedInFile = 0;
  const reject = (reason: string) => { rejected[reason] = (rejected[reason] ?? 0) + 1; };

  for (const feature of features) {
    if (!feature || feature.type !== 'Feature') {
      reject('feature_invalida');
      continue;
    }
    const event = toEvent(feature as DeterFeature, sourceCode, sourceName, refs);
    if (!event) {
      const properties = feature.properties as Record<string, unknown> | null;
      if (!validGeometry(feature.geometry)) reject('geometria_poligonal_invalida');
      else if (!validDate(pick(properties ?? {}, ['view_date', 'date', 'data']))) reject('data_observacao_invalida');
      else reject('id_externo_invalido');
      continue;
    }
    if (events.has(event.idExterno)) duplicatedInFile += 1;
    events.set(event.idExterno, event);
  }

  return { events: [...events.values()], rowsRead: features.length, duplicatedInFile, rejected };
}
