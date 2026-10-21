import { Router } from 'express';
import { query } from '../db/pool.js';
import { validateId } from '../middleware/validateId.js';
import { parseParam } from '../utils/params.js';
import { paginate, getPaginationParams } from '../utils/paginate.js';

const router = Router();

// Confiança média da IA nas ocorrências da espécie (null se nenhuma veio da IA).
const CONFIANCA_IA_SQL = `(SELECT AVG(o.confianca_ia)
   FROM ocorrencia o
   WHERE o.especie_id = e.id AND o.confianca_ia IS NOT NULL) AS confianca_ia`;

// GET /api/especies?categoria=CR&bioma=1&estado=SP&status=ativo&busca=onca&page=1&per_page=20
router.get('/', async (req, res, next) => {
  try {
    const { categoria, bioma, estado, status, busca } = req.query;
    const { page, perPage, offset } = getPaginationParams(req.query);
    const hasBusca = Boolean(busca && typeof busca === 'string');

    // Build dynamic WHERE with parameterized query.
    const conditions: string[] = [];
    const params: unknown[] = [];

    // Busca sem acento e sem caixa em nome científico + popular
    // (a colação _ai_ci substitui o unaccent(lower(...)) do PostgreSQL).
    if (hasBusca) {
      conditions.push(`(e.nome_cientifico COLLATE utf8mb4_0900_ai_ci LIKE ?
        OR COALESCE(e.nome_popular, '') COLLATE utf8mb4_0900_ai_ci LIKE ?)`);
      params.push(`%${busca}%`, `%${busca}%`);
    }
    if (categoria) {
      conditions.push('e.categoria_ameaca = ?');
      params.push(categoria);
    }
    // Default: only active species. Pass status=todos to include inactive.
    if (status !== 'todos') {
      conditions.push('e.status = ?');
      params.push(status || 'ativo');
    }
    if (bioma) {
      conditions.push('EXISTS (SELECT 1 FROM especie_bioma eb WHERE eb.especie_id = e.id AND eb.bioma_id = ?)');
      params.push(parseParam(bioma));
    }
    if (estado) {
      conditions.push('EXISTS (SELECT 1 FROM especie_estado ee WHERE ee.especie_id = e.id AND ee.estado_uf = ?)');
      params.push(estado);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // Com busca: nome popular primeiro, sem nome por último (MySQL não tem NULLS LAST).
    const orderBy = hasBusca
      ? 'e.nome_popular IS NULL, e.nome_popular, e.nome_cientifico'
      : 'e.nome_cientifico';

    const { rows } = await query(
      `SELECT e.id, e.nome_cientifico, e.nome_popular, e.categoria_ameaca, e.imagem_url,
              ${CONFIANCA_IA_SQL},
              COUNT(*) OVER() AS full_count
       FROM especie e
       ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...params, perPage, offset]
    );

    const total = rows.length > 0 ? Number(rows[0].full_count) : 0;
    const data = rows.map((r: any) => {
      const { full_count, ...rest } = r;
      return rest;
    });

    res.json(paginate(data, page, perPage, total));
  } catch (err) { next(err); }
});

// GET /api/especies/:id — detail with biomes, states, genus
router.get('/:id', validateId, async (req, res, next) => {
  try {
    const id = parseParam(req.params.id)!;

    const { rows: espRows } = await query(
      `SELECT e.id, e.nome_cientifico, e.nome_popular, e.categoria_ameaca,
              e.descricao, e.imagem_url, e.status, e.criado_em, e.atualizado_em,
              g.id AS genero_id, g.nome AS genero_nome,
              ${CONFIANCA_IA_SQL}
       FROM especie e
       JOIN taxon g ON g.id = e.genero_id
       WHERE e.id = ?`,
      [id]
    );

    if (espRows.length === 0) {
      res.status(404).json({ error: 'Species not found' });
      return;
    }

    const especie = espRows[0];

    const { rows: biomas } = await query(
      `SELECT b.id, b.nome FROM especie_bioma eb
       JOIN bioma b ON b.id = eb.bioma_id WHERE eb.especie_id = ? ORDER BY b.nome`,
      [id]
    );

    const { rows: estados } = await query(
      `SELECT s.uf, s.nome FROM especie_estado ee
       JOIN estado s ON s.uf = ee.estado_uf WHERE ee.especie_id = ? ORDER BY s.uf`,
      [id]
    );

    res.json({ ...especie, biomas, estados });
  } catch (err) { next(err); }
});

// GET /api/especies/:id/areas-protegidas — UCs onde a espécie ocorre,
// pela junção pré-calculada ocorrencia_area.
router.get('/:id/areas-protegidas', validateId, async (req, res, next) => {
  try {
    const id = parseParam(req.params.id)!;
    const { rows } = await query(
      `SELECT DISTINCT a.id AS area_id, a.nome, a.categoria_uc, a.esfera
       FROM ocorrencia_area oa
       JOIN ocorrencia     o ON o.id = oa.ocorrencia_id
       JOIN area_protegida a ON a.id = oa.area_id
       WHERE o.especie_id = ?`,
      [id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id/ocorrencias', validateId, async (req, res, next) => {
  try {
    const id = parseParam(req.params.id)!;
    const { page, perPage, offset } = getPaginationParams(req.query);

    const countRes = await query(
      'SELECT COUNT(*) AS total FROM ocorrencia WHERE especie_id = ?',
      [id]
    );
    const total = Number(countRes.rows[0].total);

    // DESC no MySQL já põe NULL por último (equivale ao NULLS LAST de antes).
    const { rows } = await query(
      `SELECT o.id, o.especie_id, o.lat, o.lon, o.data_evento, o.fonte, o.base_registro,
              o.confianca_ia,
              e.nome_cientifico, e.nome_popular, e.imagem_url, e.categoria_ameaca
       FROM ocorrencia o
       JOIN especie e ON e.id = o.especie_id
       WHERE o.especie_id = ?
       ORDER BY o.data_evento DESC
       LIMIT ? OFFSET ?`,
      [id, perPage, offset]
    );

    res.json(paginate(rows, page, perPage, total));
  } catch (err) { next(err); }
});

export default router;
