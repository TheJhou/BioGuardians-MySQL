import { Router } from 'express';
import { cacheMiddleware } from '../cache/cache.js';
import { query } from '../db/pool.js';
import { validateId } from '../middleware/validateId.js';
import { parseBbox } from '../utils/bbox.js';
import { getPaginationParams, paginate } from '../utils/paginate.js';
import { getParam, parseParam } from '../utils/params.js';
import { ENVELOPE_SQL, envelopeWkt } from '../mvt.js';

const router = Router();
const STATUSES = new Set(['novo', 'em_andamento', 'resolvido']);
const PRIORITIES = new Set(['baixa', 'media', 'alta', 'critica']);

function parseDate(value: unknown): string | undefined | null {
  const raw = getParam(value);
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? null : raw;
}

function geoJson(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  try { return JSON.parse(String(value)) as Record<string, unknown>; } catch { return null; }
}

function baseWhere(req: any): { where: string[]; params: unknown[]; error?: string } {
  const where: string[] = [];
  const params: unknown[] = [];
  const tipo = getParam(req.query.tipo);
  const fonte = getParam(req.query.fonte);
  const estado = getParam(req.query.estado_uf);
  const status = getParam(req.query.status);
  const prioridade = getParam(req.query.prioridade);
  const biomaRaw = getParam(req.query.bioma_id);
  const biomaId = biomaRaw ? parseParam(biomaRaw) : undefined;
  const desde = parseDate(req.query.desde);
  const ate = parseDate(req.query.ate);
  const bboxRaw = getParam(req.query.bbox);
  const bounds = parseBbox(bboxRaw);

  if (biomaRaw && (!biomaId || biomaId <= 0)) return { where, params, error: 'bioma_id inválido' };
  if (estado && !/^[A-Za-z]{2}$/.test(estado)) return { where, params, error: 'estado_uf deve conter duas letras' };
  if (status && !STATUSES.has(status)) return { where, params, error: 'status inválido' };
  if (prioridade && !PRIORITIES.has(prioridade)) return { where, params, error: 'prioridade inválida' };
  if (desde === null || ate === null) return { where, params, error: 'datas devem usar o formato YYYY-MM-DD' };
  if (desde && ate && desde > ate) return { where, params, error: 'desde não pode ser posterior a ate' };
  if (bboxRaw && !bounds) return { where, params, error: 'bbox inválido; use minLng,minLat,maxLng,maxLat' };

  if (tipo) { where.push('e.tipo_evento_codigo = ?'); params.push(tipo); }
  if (fonte) { where.push('f.codigo = ?'); params.push(fonte); }
  if (biomaId) { where.push('e.bioma_id = ?'); params.push(biomaId); }
  if (estado) { where.push('e.estado_uf = ?'); params.push(estado.toUpperCase()); }
  if (desde) { where.push('e.data_observacao >= ?'); params.push(`${desde} 00:00:00`); }
  if (ate) { where.push('e.data_observacao < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(`${ate} 00:00:00`); }
  if (status) { where.push('a.status = ?'); params.push(status); }
  if (prioridade) { where.push('p.nivel = ?'); params.push(prioridade); }
  if (bounds) {
    const wkt = envelopeWkt(bounds);
    where.push(`MBRIntersects(e.geom, ${ENVELOPE_SQL}) AND ST_Intersects(e.geom, ${ENVELOPE_SQL})`);
    params.push(wkt, wkt);
  }
  return { where, params };
}

function parseEventFeature(row: any): Record<string, unknown> {
  const geometry = geoJson(row.geometria);
  return {
    type: 'Feature',
    id: Number(row.id),
    geometry,
    properties: {
      tipo: row.tipo_evento_codigo,
      fonte: row.fonte_codigo,
      fonte_nome: row.fonte_nome,
      data_observacao: row.data_observacao,
      precisao_data: row.precisao_data,
      bioma: row.bioma,
      estado_uf: row.estado_uf,
      municipio: row.municipio_nome,
      satelite: row.satelite,
      risco_fogo: row.risco_fogo,
      frp_mw: row.frp_mw,
      classe_fonte: row.classe_fonte,
      area_alerta_ha: row.area_alerta_ha,
      prioridade: row.nivel_prioridade,
      score_prioridade: row.score_final,
      status_atendimento: row.status_atendimento,
    },
  };
}

const EVENT_FROM = `
  FROM monitor_evento e
  JOIN monitor_fonte f ON f.id = e.fonte_id
  LEFT JOIN bioma b ON b.id = e.bioma_id
  LEFT JOIN monitor_atendimento a ON a.evento_id = e.id
  LEFT JOIN monitor_prioridade p ON p.evento_id = e.id`;

router.get('/eventos', cacheMiddleware(undefined, () => 15_000), async (req, res, next) => {
  try {
    const filter = baseWhere(req);
    if (filter.error) { res.status(400).json({ error: filter.error }); return; }
    const { page, perPage, offset } = getPaginationParams(req.query);
    const where = filter.where.length ? `WHERE ${filter.where.join(' AND ')}` : '';
    const count = await query<{ total: number }>(`SELECT COUNT(*) AS total ${EVENT_FROM} ${where}`, filter.params);
    const result = await query<any>(
      `SELECT e.id, e.tipo_evento_codigo, f.codigo AS fonte_codigo, f.nome AS fonte_nome,
              e.data_observacao, e.precisao_data, b.nome AS bioma, e.estado_uf,
              e.municipio_nome, e.satelite, e.risco_fogo, e.frp_mw,
              e.classe_fonte, e.area_alerta_ha,
              p.nivel AS nivel_prioridade, p.score_final,
              a.status AS status_atendimento, ST_AsGeoJSON(e.geom) AS geometria
       ${EVENT_FROM} ${where}
       ORDER BY e.data_observacao IS NULL, e.data_observacao DESC, e.id DESC
       LIMIT ? OFFSET ?`,
      [...filter.params, perPage, offset]
    );
    const paginated = paginate(result.rows.map(parseEventFeature), page, perPage, Number(count.rows[0]?.total ?? 0));
    res.json({
      type: 'FeatureCollection',
      features: paginated.data,
      total: paginated.total,
      page: paginated.page,
      per_page: paginated.per_page,
      total_pages: paginated.total_pages,
    });
  } catch (error) { next(error); }
});

router.get('/resumo', cacheMiddleware(undefined, () => 30_000), async (req, res, next) => {
  try {
    const filter = baseWhere(req);
    if (filter.error) { res.status(400).json({ error: filter.error }); return; }
    const where = filter.where.length ? `WHERE ${filter.where.join(' AND ')}` : '';
    const { rows } = await query<any>(
      `SELECT e.tipo_evento_codigo, a.status AS status_atendimento,
              p.nivel AS nivel_prioridade, b.nome AS bioma, COUNT(*) AS total
       ${EVENT_FROM} ${where}
       GROUP BY e.tipo_evento_codigo, a.status, p.nivel, b.nome`,
      filter.params
    );
    const total = rows.reduce((sum, row) => sum + Number(row.total), 0);
    const grouped = (key: string) => rows.reduce((values: Record<string, number>, row) => {
      const value = row[key] ?? 'sem_classificacao';
      values[value] = (values[value] ?? 0) + Number(row.total);
      return values;
    }, {});
    res.json({ total, por_tipo: grouped('tipo_evento_codigo'), por_status: grouped('status_atendimento'),
      por_prioridade: grouped('nivel_prioridade'), por_bioma: grouped('bioma') });
  } catch (error) { next(error); }
});

router.get('/fontes', cacheMiddleware(undefined, () => 30_000), async (_req, res, next) => {
  try {
    const { rows } = await query<any>(
      `SELECT f.id, f.codigo, f.nome, f.orgao, f.produto, f.formato,
              f.frequencia_minutos, f.ativo,
              latest.id AS ultima_execucao_id, latest.status AS ultimo_status,
              latest.iniciada_em AS ultima_execucao_em, latest.concluida_em,
              latest.registros_lidos, latest.registros_novos,
              latest.registros_atualizados, latest.registros_rejeitados,
              latest.erro AS ultimo_erro
       FROM monitor_fonte f
       LEFT JOIN monitor_execucao latest ON latest.id = (
         SELECT MAX(e.id) FROM monitor_execucao e WHERE e.fonte_id = f.id
       )
       ORDER BY f.id`
    );
    res.json({ data: rows });
  } catch (error) { next(error); }
});

router.get('/execucoes/:id', validateId, cacheMiddleware(undefined, () => 10_000), async (req, res, next) => {
  try {
    const { rows } = await query<any>(
      `SELECT e.*, f.codigo AS fonte_codigo, f.nome AS fonte_nome
       FROM monitor_execucao e JOIN monitor_fonte f ON f.id = e.fonte_id
       WHERE e.id = ?`,
      [req.params.id]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Execução não encontrada' }); return; }
    res.json(rows[0]);
  } catch (error) { next(error); }
});

router.get('/eventos/:id', validateId, cacheMiddleware(undefined, () => 15_000), async (req, res, next) => {
  try {
    const { rows } = await query<any>(
      `SELECT e.id, e.tipo_evento_codigo, f.codigo AS fonte_codigo, f.nome AS fonte_nome,
              e.id_externo, e.data_observacao, e.precisao_data, b.nome AS bioma,
              e.estado_uf, e.municipio_nome, e.municipio_codigo_ibge, e.satelite,
              e.risco_fogo, e.frp_mw, e.classe_fonte, e.area_alerta_ha,
              e.primeira_importacao_em, e.ultima_vista_em, e.atualizado_em,
              a.status AS status_atendimento, a.responsavel, a.criado_em AS atendimento_criado_em,
              a.iniciado_em, a.resolvido_em, p.versao_algoritmo, p.score_risco,
              p.score_recencia, p.score_sensibilidade, p.score_final,
              p.nivel AS nivel_prioridade, ST_AsGeoJSON(e.geom) AS geometria
       ${EVENT_FROM} WHERE e.id = ? LIMIT 1`,
      [req.params.id]
    );
    const row = rows[0];
    if (!row) { res.status(404).json({ error: 'Evento não encontrado' }); return; }

    const [history, areas] = await Promise.all([
      query<any>(
        `SELECT status_anterior, status_novo, alterado_em, ator, observacao
         FROM monitor_atendimento_historico WHERE evento_id = ? ORDER BY alterado_em, id`,
        [req.params.id]
      ),
      query<any>(
        `SELECT a.id, a.nome, a.categoria_uc, a.esfera, r.tipo_relacao, r.intersecao_ha
         FROM monitor_evento_uc r JOIN area_protegida a ON a.id = r.area_id
         WHERE r.evento_id = ? ORDER BY a.nome`,
        [req.params.id]
      ),
    ]);

    const feature = parseEventFeature(row);
    res.json({
      ...feature,
      properties: { ...(feature.properties as Record<string, unknown>), id_externo: row.id_externo,
        municipio_codigo_ibge: row.municipio_codigo_ibge, primeira_importacao_em: row.primeira_importacao_em,
        ultima_vista_em: row.ultima_vista_em, atualizado_em: row.atualizado_em },
      atendimento: { status: row.status_atendimento, responsavel: row.responsavel,
        criado_em: row.atendimento_criado_em, iniciado_em: row.iniciado_em, resolvido_em: row.resolvido_em },
      prioridade: row.nivel_prioridade ? { versao_algoritmo: row.versao_algoritmo,
        score_risco: row.score_risco, score_recencia: row.score_recencia,
        score_sensibilidade: row.score_sensibilidade, score_final: row.score_final,
        nivel: row.nivel_prioridade } : null,
      historico_atendimento: history.rows,
      unidades_conservacao: areas.rows,
    });
  } catch (error) { next(error); }
});

export default router;
