import { Router } from 'express';
import { query } from '../db/pool.js';
import { validateId } from '../middleware/validateId.js';
import { cacheMiddleware, getTileCache, setTileCache } from '../cache/cache.js';
import { env } from '../config/env.js';
import { parseParam } from '../utils/params.js';
import { parseBbox } from '../utils/bbox.js';
import { encodeTile, envelopeWkt, tileEnvelope, ENVELOPE_SQL, type TileFeature } from '../mvt.js';

const router = Router();

// Margem do tile em unidades MVT (4096 = 1 tile) para o raio do círculo
// não ser cortado na borda entre tiles vizinhos.
const OCORRENCIA_TILE_BUFFER = 64;

function isValidTile(z: number, x: number, y: number): boolean {
  if (Number.isNaN(z) || Number.isNaN(x) || Number.isNaN(y)) return false;
  if (z < 0 || z > 20) return false;
  const max = 1 << z;
  return x >= 0 && x < max && y >= 0 && y < max;
}

function sendTile(res: any, buffer: Buffer): void {
  res.set('Content-Type', 'application/vnd.mapbox-vector-tile');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(buffer);
}

// Lista de IDs separada por vírgula (multi-seleção de espécies), normalizada:
// ordenada e sem repetição ("2,1" e "1,2" são o mesmo filtro).
function parseIds(value: unknown): number[] {
  if (!value) return [];
  const ids = String(value).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].sort((a, b) => a - b);
}

// GET /api/ocorrencias?especie_id=42 — returns GeoJSON FeatureCollection
// Supports bbox (minLng,minLat,maxLng,maxLat) to filter by visible map region.
router.get('/', cacheMiddleware(undefined, () => 30_000), async (req, res, next) => {
  try {
    const { especie_id, categoria, bioma, fonte, limit, bbox, incluir_inativos } = req.query;

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Default: hide occurrences of inactive species (non-wildlife, e.g. humans/domestic).
    // Pass incluir_inativos=true to see them.
    if (incluir_inativos !== 'true') {
      conditions.push(`e.status = 'ativo'`);
    }

    const ids = parseIds(especie_id);
    if (ids.length > 0) {
      conditions.push('o.especie_id IN (?)');
      params.push(ids);
    }
    if (categoria) {
      conditions.push('e.categoria_ameaca = ?');
      params.push(categoria);
    }
    if (bioma) {
      conditions.push('EXISTS (SELECT 1 FROM especie_bioma eb WHERE eb.especie_id = o.especie_id AND eb.bioma_id = ?)');
      params.push(parseParam(bioma));
    }
    if (fonte) {
      conditions.push('o.fonte = ?');
      params.push(fonte);
    }
    const bounds = parseBbox(bbox);
    if (bounds) {
      // MBRIntersects usa o índice espacial; o BETWEEN nas colunas deixa o
      // recorte exato em lon/lat (a aresta geodésica do envelope se curva).
      conditions.push(`MBRIntersects(o.geom, ${ENVELOPE_SQL})
        AND o.lon BETWEEN ? AND ? AND o.lat BETWEEN ? AND ?`);
      params.push(envelopeWkt(bounds), bounds.minLon, bounds.maxLon, bounds.minLat, bounds.maxLat);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push((limit && parseParam(limit)) || 10000);

    const { rows } = await query(
      `SELECT o.id, o.especie_id, o.lat, o.lon, o.data_evento, o.fonte, o.base_registro,
              o.confianca_ia,
              e.nome_cientifico, e.nome_popular, e.imagem_url, e.categoria_ameaca
       FROM ocorrencia o
       JOIN especie e ON e.id = o.especie_id
       ${where}
       LIMIT ?`,
      params
    );

    res.json({
      type: 'FeatureCollection',
      features: rows.map((r: any) => {
        const { id, ...properties } = r;
        return {
          type: 'Feature',
          id,
          geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
          properties,
        };
      }),
    });
  } catch (err) { next(err); }
});

// GET /api/ocorrencias/tiles/:z/:x/:y.mvt — vector tiles for occurrences (MVT).
router.get('/tiles/:z/:x/:y.mvt', async (req, res, next) => {
  try {
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    const y = parseInt(req.params.y, 10);
    if (!isValidTile(z, x, y)) {
      res.status(400).json({ error: 'Invalid tile coordinates' });
      return;
    }

    const { especie_id, categoria, bioma, fonte, incluir_inativos } = req.query;
    const ids = parseIds(especie_id);
    // Chave a partir dos filtros normalizados, não da URL crua.
    const key = `route:/api/ocorrencias/tiles/${z}/${x}/${y}?` +
      `e=${ids.join(',')}&c=${categoria ?? ''}&b=${bioma ?? ''}&f=${fonte ?? ''}&i=${incluir_inativos === 'true'}`;
    const cached = getTileCache(key);
    if (cached) {
      sendTile(res, cached);
      return;
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Candidatos pelo índice espacial; o recorte exato no tile é do geojson-vt.
    const envelope = tileEnvelope(z, x, y, OCORRENCIA_TILE_BUFFER);
    if (envelope) {
      conditions.push(`MBRIntersects(o.geom, ${ENVELOPE_SQL})`);
      params.push(envelope);
    }
    if (incluir_inativos !== 'true') {
      conditions.push(`e.status = 'ativo'`);
    }
    if (ids.length > 0) {
      conditions.push('o.especie_id IN (?)');
      params.push(ids);
    }
    if (categoria) {
      conditions.push('e.categoria_ameaca = ?');
      params.push(categoria);
    }
    if (bioma) {
      conditions.push('EXISTS (SELECT 1 FROM especie_bioma eb WHERE eb.especie_id = o.especie_id AND eb.bioma_id = ?)');
      params.push(parseParam(bioma));
    }
    if (fonte) {
      conditions.push('o.fonte = ?');
      params.push(fonte);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await query<{ id: number; especie_id: number; categoria_ameaca: string; lon: number; lat: number }>(
      `SELECT o.id, o.especie_id, e.categoria_ameaca, o.lon, o.lat
       FROM ocorrencia o
       JOIN especie e ON e.id = o.especie_id
       ${where}`,
      params
    );

    const features: TileFeature[] = rows.map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      properties: { id: r.id, especie_id: r.especie_id, categoria_ameaca: r.categoria_ameaca },
    }));

    const buffer = encodeTile('ocorrencia', features, z, x, y, OCORRENCIA_TILE_BUFFER);
    setTileCache(key, buffer);
    sendTile(res, buffer);
  } catch (err) { next(err); }
});

// GET /api/ocorrencias/gbif?especie=panthera+onca — proxy to GBIF API, cached 5min
router.get('/gbif', cacheMiddleware(
  (req) => `gbif:${req.query.especie}`,
  () => 300_000
), async (req, res, next) => {
  try {
    const { especie } = req.query;
    if (!especie) {
      res.status(400).json({ error: 'especie query param is required' });
      return;
    }

    const url = `${env.gbifApiBase}/occurrence/search?country=BR&scientificName=${encodeURIComponent(especie as string)}&limit=50&hasCoordinate=true`;

    const response = await fetch(url);
    if (!response.ok) {
      res.status(response.status).json({ error: 'GBIF API error' });
      return;
    }

    const data = await response.json() as { results?: Record<string, unknown>[]; count?: number };
    const features = (data.results || []).map((r) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [r.decimalLongitude, r.decimalLatitude],
      },
      properties: {
        especie: r.scientificName,
        data: r.eventDate,
        fonte: 'gbif',
        base_registro: r.institutionCode,
        gbif_id: r.key,
      },
    }));

    res.json({
      type: 'FeatureCollection',
      features,
      count: features.length,
      gbif_total: data.count,
    });
  } catch (err) { next(err); }
});

// GET /api/ocorrencias/:id — detalhe completo (buscado no clique do mapa;
// o tile carrega só id + categoria pra manter o payload leve)
router.get('/:id', validateId, async (req, res, next) => {
  try {
    const id = parseParam(req.params.id)!;
    const { rows } = await query(
      `SELECT o.id, o.especie_id, o.lat, o.lon,
              o.data_evento, o.fonte, o.base_registro,
              o.confianca_ia,
              e.nome_cientifico, e.nome_popular, e.imagem_url, e.categoria_ameaca
       FROM ocorrencia o
       JOIN especie e ON e.id = o.especie_id
       WHERE o.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Occurrence not found' });
      return;
    }

    res.json(rows[0]);
  } catch (err) { next(err); }
});

export default router;
