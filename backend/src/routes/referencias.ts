import { Router } from 'express';
import { query } from '../db/pool.js';
import { cacheMiddleware } from '../cache/cache.js';

const router = Router();

// GET /api/biomas — cached 60s
router.get('/biomas', cacheMiddleware(undefined, () => 60_000), async (_req, res, next) => {
  try {
    const { rows } = await query('SELECT id, nome, descricao FROM bioma ORDER BY id');
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/estados — cached 60s
router.get('/estados', cacheMiddleware(undefined, () => 60_000), async (_req, res, next) => {
  try {
    const { rows } = await query('SELECT uf, nome, regiao FROM estado ORDER BY uf');
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/categorias — cached 60s
router.get('/categorias', cacheMiddleware(undefined, () => 60_000), async (_req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT codigo, nome, descricao, ordem_prioridade FROM categoria_ameaca ORDER BY ordem_prioridade'
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/taxonomia?rank=genero — cached 60s
router.get('/taxonomia', cacheMiddleware(undefined, () => 60_000), async (req, res, next) => {
  try {
    const { rank } = req.query;
    if (rank) {
      const { rows } = await query(
        'SELECT id, nome, `rank`, parent_id FROM taxon WHERE `rank` = ? ORDER BY nome',
        [rank]
      );
      res.json(rows);
    } else {
      const { rows } = await query(
        'SELECT id, nome, `rank`, parent_id FROM taxon ORDER BY id'
      );
      res.json(rows);
    }
  } catch (err) { next(err); }
});

export default router;
