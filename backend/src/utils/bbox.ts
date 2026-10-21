import type { TileBounds } from '../mvt.js';

// bbox "minLng,minLat,maxLng,maxLat" (query param do mapa) → limites em
// lon/lat, ou null se ausente/inválido. Use com envelopeWkt + ENVELOPE_SQL.
// Acima de 90° de largura não filtra: em SRID 4326 as arestas são geodésicas
// e um retângulo tão largo deixa de representar a área visível.
export function parseBbox(bbox: unknown): TileBounds | null {
  if (!bbox) return null;
  const parts = String(bbox).split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null;
  const minLon = Math.max(-180, parts[0]);
  const minLat = Math.max(-90, parts[1]);
  const maxLon = Math.min(180, parts[2]);
  const maxLat = Math.min(90, parts[3]);
  if (minLon >= maxLon || minLat >= maxLat || maxLon - minLon > 90) return null;
  return { minLon, minLat, maxLon, maxLat };
}
