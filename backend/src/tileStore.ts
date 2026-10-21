import { query } from './db/pool.js';
import { encodeTile, tileEnvelope, ENVELOPE_SQL, type TileFeature } from './mvt.js';

// Geração e persistência de tiles MVT de áreas protegidas.
// Os tiles persistidos cobrem o dataset completo (sem filtros): requests
// com filtro geram o tile na hora e ficam só no LRU em memória.

// Margem do tile em unidades MVT (4096 = 1 tile): polígonos que passam
// perto da borda entram, para não aparecer emenda entre tiles vizinhos.
const AREA_TILE_BUFFER = 256;

export interface AreaTileFilters {
  esfera?: string;
  categoria?: string;
  bioma?: number;
}

// Geometria simplificada para exibição, com a tolerância (graus) no 1º "?".
// - ST_Simplify do MySQL só aceita SRID cartesiano; ST_SRID(geom, 0) troca o
//   SRID sem mexer nas coordenadas (continuam lon/lat).
// - Quando o polígono inteiro é menor que a tolerância, o MySQL devolve NULL
//   (o PostGIS tinha preserveCollapsed). Sem fallback, toda UC pequena sumiria
//   nos zooms baixos: tenta 1/16 da tolerância e, por fim, a geometria
//   original (só UCs minúsculas chegam aí, então o custo é pequeno).
export const SIMPLIFIED_GEOM_SQL = `COALESCE(
  ST_Simplify(ST_SRID(a.geom, 0), ?),
  ST_Simplify(ST_SRID(a.geom, 0), ? / 16),
  ST_SRID(a.geom, 0))`;

// Simplificação no banco: tolerância de ~1 pixel (tile de 256 px) em graus.
export async function generateAreaTile(
  z: number, x: number, y: number,
  filters: AreaTileFilters = {}
): Promise<Buffer> {
  const conditions: string[] = [];
  const tolerance = 360 / (256 * 2 ** z);
  const params: unknown[] = [tolerance, tolerance];

  const envelope = tileEnvelope(z, x, y, AREA_TILE_BUFFER);
  if (envelope) {
    conditions.push(`MBRIntersects(a.geom, ${ENVELOPE_SQL})`);
    params.push(envelope);
  }
  if (filters.esfera) { conditions.push('a.esfera = ?'); params.push(filters.esfera); }
  if (filters.categoria) { conditions.push('a.categoria_uc = ?'); params.push(filters.categoria); }
  if (filters.bioma !== undefined) { conditions.push('a.bioma_id = ?'); params.push(filters.bioma); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query<{ id: number; categoria_uc: string; geometry: TileFeature['geometry'] | null }>(
    `SELECT a.id, a.categoria_uc,
            ST_AsGeoJSON(${SIMPLIFIED_GEOM_SQL}, 6) AS geometry
     FROM area_protegida a
     ${where}`,
    params
  );

  const features: TileFeature[] = rows
    .filter((r) => r.geometry)
    .map((r) => ({
      type: 'Feature',
      geometry: r.geometry!,
      properties: { id: r.id, categoria_uc: r.categoria_uc },
    }));

  return encodeTile('uc', features, z, x, y, AREA_TILE_BUFFER);
}

export async function getStoredAreaTile(z: number, x: number, y: number): Promise<Buffer | null> {
  const { rows } = await query<{ tile: Buffer }>(
    'SELECT tile FROM area_tile WHERE z = ? AND x = ? AND y = ?',
    [z, x, y]
  );
  return rows.length > 0 ? rows[0].tile : null;
}

export async function storeAreaTile(z: number, x: number, y: number, tile: Buffer): Promise<void> {
  await query(
    `INSERT INTO area_tile (z, x, y, tile) VALUES (?, ?, ?, ?) AS novo
     ON DUPLICATE KEY UPDATE tile = novo.tile, gerado_em = CURRENT_TIMESTAMP(6)`,
    [z, x, y, tile]
  );
}
