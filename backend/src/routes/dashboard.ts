import { Router } from 'express';
import { query } from '../db/pool.js';
import { cacheMiddleware } from '../cache/cache.js';

const router = Router();

// GET /api/dashboard — agregados pré-calculados (tabelas preenchidas por
// CALL refresh_dashboard()) + consultas leves, em paralelo.
// Cached for 60s. Uses Promise.all to fetch everything concurrently.
router.get('/', cacheMiddleware(undefined, () => 60_000), async (_req, res, next) => {
  try {
    const [stats, ranking, ucsEsfera, especiesUc, especiesBioma, occAno, ucsCategoria, topEspecies] = await Promise.all([
      query('SELECT total_especies, total_cr, total_en, total_vu, total_nt, total_lc, total_dd, total_areas, area_total_ha, total_ocorrencias FROM dashboard_stats'),
      // Tabela comum não guarda ordem (a view materializada guardava): ordena pela gravidade.
      query(
        `SELECT r.categoria_ameaca, r.total
         FROM ranking_especies_categoria r
         JOIN categoria_ameaca c ON c.codigo = r.categoria_ameaca
         ORDER BY c.ordem_prioridade`
      ),
      query('SELECT esfera, total, area_ha FROM ucs_por_esfera ORDER BY total DESC'),
      // Top 6 espécies por quantidade de UCs distintas em que ocorrem
      // (junção pré-calculada por trigger — cobre todas as espécies ativas).
      query(
        `SELECT e.id AS especie_id, e.nome_cientifico, e.nome_popular, e.imagem_url,
                COUNT(DISTINCT oa.area_id) AS total_ucs
         FROM ocorrencia_area oa
         JOIN ocorrencia o ON o.id = oa.ocorrencia_id
         JOIN especie e ON e.id = o.especie_id AND e.status = 'ativo'
         GROUP BY e.id, e.nome_cientifico, e.nome_popular, e.imagem_url
         ORDER BY total_ucs DESC, e.nome_cientifico
         LIMIT 6`
      ),
      // Espécies por bioma (via vínculo especie↔bioma).
      query(
        `SELECT b.nome, COUNT(DISTINCT e.id) AS total
         FROM bioma b
         JOIN especie_bioma eb ON eb.bioma_id = b.id
         JOIN especie e ON e.id = eb.especie_id AND e.status = 'ativo'
         GROUP BY b.nome
         ORDER BY total DESC`
      ),
      // Ocorrências por ano — data_evento com fallback para criado_em,
      // assim registros sem data do evento também entram no gráfico.
      query(
        `SELECT YEAR(COALESCE(o.data_evento, o.criado_em)) AS ano, COUNT(*) AS total
         FROM ocorrencia o
         GROUP BY ano
         ORDER BY ano`
      ),
      query(
        `SELECT categoria_uc, COUNT(*) AS total
         FROM area_protegida
         GROUP BY categoria_uc`
      ),
      // Top 6 espécies por número de ocorrências.
      query(
        `SELECT o.especie_id, e.nome_cientifico, e.nome_popular, COUNT(*) AS total
         FROM ocorrencia o
         JOIN especie e ON e.id = o.especie_id AND e.status = 'ativo'
         GROUP BY o.especie_id, e.nome_cientifico, e.nome_popular
         ORDER BY total DESC, e.nome_cientifico
         LIMIT 6`
      ),
    ]);

    res.json({
      stats: stats.rows[0],
      ranking: ranking.rows,
      ucs_por_esfera: ucsEsfera.rows,
      especies_mais_presentes_uc: especiesUc.rows,
      especies_por_bioma: especiesBioma.rows,
      ocorrencias_por_ano: occAno.rows,
      ucs_por_categoria: ucsCategoria.rows,
      especies_mais_ocorrencias: topEspecies.rows,
    });
  } catch (err) { next(err); }
});

export default router;
