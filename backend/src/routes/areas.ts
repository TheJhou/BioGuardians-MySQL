import { Router } from 'express';
import { query } from '../db/pool.js';
import { validateId } from '../middleware/validateId.js';
import { cacheMiddleware, getTileCache, setTileCache } from '../cache/cache.js';
import { parseParam, getParam } from '../utils/params.js';
import { getStoredAreaTile, storeAreaTile, generateAreaTile, SIMPLIFIED_GEOM_SQL } from '../tileStore.js';
import { ENVELOPE_SQL, envelopeWkt } from '../mvt.js';
import { parseBbox } from '../utils/bbox.js';

const router = Router();

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

// GET /api/areas — returns GeoJSON FeatureCollection, cached 30s
// Supports bbox (minLng,minLat,maxLng,maxLat) and zoom for geometry simplification.
router.get('/', cacheMiddleware(undefined, () => 30_000), async (req, res, next) => {
  try {
    const { bioma, esfera, categoria, busca, bbox, zoom } = req.query;

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Tolerância de simplificação por zoom (graus).
    const zoomLevel = zoom ? parseInt(String(zoom), 10) : 10;
    const tolerance = zoomLevel > 12 ? 0.001 : zoomLevel > 8 ? 0.01 : 0.1;
    params.push(tolerance, tolerance);

    if (bioma) { conditions.push('a.bioma_id = ?'); params.push(parseParam(bioma)); }
    if (esfera) { conditions.push('a.esfera = ?'); params.push(esfera); }
    if (categoria) { conditions.push('a.categoria_uc = ?'); params.push(categoria); }
    if (busca && typeof busca === 'string') {
      // Sem acento e sem caixa (equivale ao ILIKE + unaccent do PostgreSQL).
      conditions.push(`(a.nome COLLATE utf8mb4_0900_ai_ci LIKE ?
        OR a.esfera COLLATE utf8mb4_0900_ai_ci LIKE ?
        OR b.nome COLLATE utf8mb4_0900_ai_ci LIKE ?)`);
      params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`);
    }

    // Bounding box filter: only return areas intersecting the visible map region
    const bounds = parseBbox(bbox);
    if (bounds) {
      conditions.push(`MBRIntersects(a.geom, ${ENVELOPE_SQL})`);
      params.push(envelopeWkt(bounds));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Uma única query: metadados + geometria simplificada (ver SIMPLIFIED_GEOM_SQL).
    const { rows } = await query(
      `SELECT a.id, a.nome, a.categoria_uc, a.esfera, a.bioma_id, a.area_ha,
              ST_AsGeoJSON(${SIMPLIFIED_GEOM_SQL}, 5) AS geometry
       FROM area_protegida a
       LEFT JOIN bioma b ON b.id = a.bioma_id
       ${where}
       ORDER BY a.id
       LIMIT 500`,
      params
    );

    res.json({
      type: 'FeatureCollection',
      features: rows.map((r: any) => ({
        type: 'Feature',
        id: r.id,
        geometry: r.geometry,
        properties: {
          id: r.id,
          nome: r.nome,
          categoria_uc: r.categoria_uc,
          esfera: r.esfera,
          bioma_id: r.bioma_id,
          area_ha: r.area_ha,
        },
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/areas/tiles/:z/:x/:y.mvt — vector tiles for UCs (MVT).
router.get('/tiles/:z/:x/:y.mvt', async (req, res, next) => {
  try {
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    const y = parseInt(req.params.y, 10);
    if (!isValidTile(z, x, y)) {
      res.status(400).json({ error: 'Invalid tile coordinates' });
      return;
    }

    const esfera = getParam(req.query.esfera);
    const categoria = getParam(req.query.categoria);
    const bioma = parseParam(req.query.bioma);
    const hasFilters = Boolean(esfera || categoria || bioma !== undefined);

    // Cache persistente: tiles pré-gerados cobrem o dataset completo.
    // Requests com filtro não usam a tabela (cada filtro geraria uma
    // variante do tile) — ficam só no LRU em memória.
    if (!hasFilters) {
      const stored = await getStoredAreaTile(z, x, y);
      if (stored) {
        sendTile(res, stored);
        return;
      }
    }

    const key = `route:${req.originalUrl}`;
    const cached = getTileCache(key);
    if (cached) {
      sendTile(res, cached);
      return;
    }

    const buffer = await generateAreaTile(z, x, y, { esfera, categoria, bioma });
    if (!hasFilters) {
      try {
        await storeAreaTile(z, x, y, buffer);
      } catch {
        // Persistência best-effort — a resposta já está garantida.
      }
    }
    setTileCache(key, buffer);
    sendTile(res, buffer);
  } catch (err) { next(err); }
});

// GET /api/areas/:id — single area as GeoJSON Feature
router.get('/:id', validateId, async (req, res, next) => {
  try {
    const id = parseParam(req.params.id)!;
    const { rows } = await query(
      `SELECT a.id, a.nome, a.categoria_uc, a.esfera, a.bioma_id, a.area_ha,
              a.criado_em, a.atualizado_em,
              ST_AsGeoJSON(a.geom) AS geometry
       FROM area_protegida a WHERE a.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Area not found' });
      return;
    }

    const { geometry, ...properties } = rows[0];
    res.json({ type: 'Feature', id: properties.id, geometry, properties });
  } catch (err) { next(err); }
});

// GET /api/areas/:id/info — metadados leves para o clique do mapa (sem geometria;
// o tile carrega só id + categoria_uc pra manter o payload pequeno)
router.get('/:id/info', validateId, async (req, res, next) => {
  try {
    const id = parseParam(req.params.id)!;
    const { rows } = await query(
      `SELECT a.id, a.nome, a.categoria_uc, a.esfera,
              a.bioma_id, b.nome AS bioma, a.area_ha
       FROM area_protegida a
       LEFT JOIN bioma b ON b.id = a.bioma_id
       WHERE a.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Area not found' });
      return;
    }

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// GET /api/areas/:id/especies — espécies ameaçadas (CR/EN/VU) com ocorrência
// dentro da UC, pela junção pré-calculada ocorrencia_area.
router.get('/:id/especies', validateId, async (req, res, next) => {
  try {
    const id = parseParam(req.params.id)!;
    const { rows } = await query(
      `SELECT DISTINCT e.id AS especie_id, e.nome_cientifico, e.nome_popular,
              e.categoria_ameaca AS categoria
       FROM ocorrencia_area oa
       JOIN ocorrencia o ON o.id = oa.ocorrencia_id
       JOIN especie    e ON e.id = o.especie_id
       WHERE oa.area_id = ?
         AND e.categoria_ameaca IN ('CR','EN','VU')`,
      [id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
