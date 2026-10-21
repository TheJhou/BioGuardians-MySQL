import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import type { Feature, Geometry } from 'geojson';

// Geração de tiles vetoriais (MVT) no Node. O MySQL não tem ST_AsMVT /
// ST_AsMVTGeom / ST_TileEnvelope: o banco só filtra as geometrias que
// tocam o tile (índice espacial) e devolve GeoJSON; o recorte, a projeção
// para Web Mercator e a codificação em protobuf ficam com geojson-vt + vt-pbf.

const EXTENT = 4096;
const MAX_MERCATOR_LAT = 85.0511287798066;

// Abaixo deste zoom o tile cobre 90°+ de longitude. Em SRID 4326 as arestas
// de um polígono são geodésicas, e um "retângulo" tão largo deixa de
// representar o tile: nesses zooms o banco não filtra por envelope.
const MIN_ZOOM_FOR_ENVELOPE = 3;

export interface TileBounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

function tileYToLat(y: number, z: number): number {
  const n = Math.PI * (1 - (2 * y) / 2 ** z);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

// Bounds do tile em lon/lat, com margem de `buffer` unidades de tile
// (mesma unidade do buffer do MVT: 4096 = um tile inteiro).
export function tileBounds(z: number, x: number, y: number, buffer = 0): TileBounds {
  const pad = buffer / EXTENT;
  return {
    minLon: Math.max(-180, tileXToLon(x - pad, z)),
    maxLon: Math.min(180, tileXToLon(x + 1 + pad, z)),
    maxLat: Math.min(MAX_MERCATOR_LAT, tileYToLat(y - pad, z)),
    minLat: Math.max(-MAX_MERCATOR_LAT, tileYToLat(y + 1 + pad, z)),
  };
}

// WKT do envelope em lon/lat. Use sempre com
// ST_GeomFromText(?, 4326, 'axis-order=long-lat') — sem a opção, o MySQL
// lê lat/lon para SRID 4326.
export function envelopeWkt(b: TileBounds): string {
  return `POLYGON((${b.minLon} ${b.minLat}, ${b.maxLon} ${b.minLat}, ` +
    `${b.maxLon} ${b.maxLat}, ${b.minLon} ${b.maxLat}, ${b.minLon} ${b.minLat}))`;
}

export const ENVELOPE_SQL = `ST_GeomFromText(?, 4326, 'axis-order=long-lat')`;

// Se o zoom permite filtrar por envelope, devolve o WKT; senão, null
// (a query não deve aplicar filtro espacial).
export function tileEnvelope(z: number, x: number, y: number, buffer: number): string | null {
  return z >= MIN_ZOOM_FOR_ENVELOPE ? envelopeWkt(tileBounds(z, x, y, buffer)) : null;
}

export type TileFeature = Feature<Geometry, Record<string, string | number | null>>;

// Codifica as features (lon/lat) como um tile MVT de uma camada.
// Tile sem nenhuma feature = buffer vazio (o mesmo que o ST_AsMVT devolvia).
export function encodeTile(
  layer: string,
  features: TileFeature[],
  z: number, x: number, y: number,
  buffer: number
): Buffer {
  if (features.length === 0) return Buffer.alloc(0);

  const index = geojsonvt(
    { type: 'FeatureCollection', features },
    {
      maxZoom: Math.max(z, 1),
      // Índice criado por request: não pré-gera a pirâmide, só desce até o tile pedido.
      indexMaxZoom: 0,
      indexMaxPoints: 0,
      extent: EXTENT,
      buffer,
    }
  );
  const tile = index.getTile(z, x, y);
  if (!tile || tile.features.length === 0) return Buffer.alloc(0);

  return Buffer.from(vtpbf.fromGeojsonVt({ [layer]: tile }, { version: 2 }));
}
