import { Router } from 'express';
import { cacheMiddleware, getTileCache, setTileCache } from '../cache/cache.js';
import { query } from '../db/pool.js';
import { validateId } from '../middleware/validateId.js';
import { parseBbox } from '../utils/bbox.js';
import { getPaginationParams, paginate } from '../utils/paginate.js';
import { getParam, parseParam } from '../utils/params.js';
import { ENVELOPE_SQL, encodeTile, envelopeWkt, tileEnvelope, type TileFeature } from '../mvt.js';

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
  // Filtra por e.fonte_id (índice fonte+data) sem depender do join com monitor_fonte.
  if (fonte) { where.push('e.fonte_id = (SELECT id FROM monitor_fonte WHERE codigo = ?)'); params.push(fonte); }
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

// A contagem e a paginação param em MAX_COUNTED eventos: contar ~700 mil linhas
// (e pular OFFSETs enormes) a cada página custava segundos. Acima disso a API
// devolve total = MAX_COUNTED e total_limitado = true; use filtros para refinar.
const MAX_COUNTED = 10_000;

/** FROM mínimo (contagem e página de ids): só faz join com o que algum filtro usa. */
function filterFrom(where: string[]): string {
  const joins = [
    where.some((clause) => clause.startsWith('a.')) ? 'JOIN monitor_atendimento a ON a.evento_id = e.id' : '',
    where.some((clause) => clause.startsWith('p.')) ? 'JOIN monitor_prioridade p ON p.evento_id = e.id' : '',
  ].filter(Boolean).join(' ');
  return `FROM monitor_evento e ${joins}`;
}

/**
 * Com filtro de status/prioridade raro (ex.: 'resolvido' com 0 linhas), percorrer
 * o índice por data até achar per_page linhas varreria a tabela toda; melhor o
 * otimizador começar pelo índice de status. Já um valor comum ('novo' = 100%)
 * fica rápido pela data e lento pelo status (ordena tudo: ~1,8 s com 700 mil).
 * A proporção vem de monitor_resumo (uma linha); sem resumo, deixa o otimizador decidir.
 */
async function joinPlan(req: any): Promise<'default' | 'date_first' | 'status_first'> {
  const status = getParam(req.query.status);
  const prioridade = getParam(req.query.prioridade);
  if (!status && !prioridade) return 'default';
  const { rows } = await query<any>('SELECT total, por_status, por_prioridade FROM monitor_resumo WHERE id = 1');
  const snapshot = rows[0];
  const total = Number(snapshot?.total ?? 0);
  if (!total) return 'status_first';
  const share = (counts: Record<string, number> | null, value: string | undefined) =>
    value ? Number(counts?.[value] ?? 0) / total : 1;
  const rarest = Math.min(share(snapshot.por_status, status), share(snapshot.por_prioridade, prioridade));
  return rarest < 0.05 ? 'status_first' : 'date_first';
}

router.get('/eventos', cacheMiddleware(undefined, () => 60_000), async (req, res, next) => {
  try {
    const filter = baseWhere(req);
    if (filter.error) { res.status(400).json({ error: filter.error }); return; }
    const { page, perPage, offset } = getPaginationParams(req.query);
    if (offset + perPage > MAX_COUNTED) {
      res.status(400).json({ error: `A listagem vai até ${MAX_COUNTED} eventos; use filtros para refinar a busca` });
      return;
    }
    const where = filter.where.length ? `WHERE ${filter.where.join(' AND ')}` : '';
    // date_first: STRAIGHT_JOIN fixa monitor_evento na frente, senão um filtro de
    // status comum puxa monitor_atendimento para a frente e o ORDER BY vira filesort.
    const modifier = (await joinPlan(req)) === 'date_first' ? 'STRAIGHT_JOIN' : '';
    // Join adiado: a subconsulta escolhe só os ids da página (índice por data,
    // coberto, para em OFFSET + LIMIT linhas) e só então busca as colunas e os
    // joins dessas linhas. Pedindo todas as colunas numa consulta só, o otimizador
    // preferia ler a tabela inteira e ordenar (~3,7 s com 700 mil eventos).
    const [count, result] = await Promise.all([
      query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM (SELECT 1 ${filterFrom(filter.where)} ${where} LIMIT ?) capped`,
        [...filter.params, MAX_COUNTED + 1]
      ),
      query<any>(
        `SELECT e.id, e.tipo_evento_codigo, f.codigo AS fonte_codigo, f.nome AS fonte_nome,
                e.data_observacao, e.precisao_data, b.nome AS bioma, e.estado_uf,
                e.municipio_nome, e.satelite, e.risco_fogo, e.frp_mw,
                e.classe_fonte, e.area_alerta_ha,
                p.nivel AS nivel_prioridade, p.score_final,
                a.status AS status_atendimento, ST_AsGeoJSON(e.geom) AS geometria
         FROM (
           SELECT ${modifier} e.id ${filterFrom(filter.where)} ${where}
           ORDER BY e.data_observacao DESC, e.id DESC
           LIMIT ? OFFSET ?
         ) page
         JOIN monitor_evento e ON e.id = page.id
         JOIN monitor_fonte f ON f.id = e.fonte_id
         LEFT JOIN bioma b ON b.id = e.bioma_id
         LEFT JOIN monitor_atendimento a ON a.evento_id = e.id
         LEFT JOIN monitor_prioridade p ON p.evento_id = e.id
         ORDER BY e.data_observacao DESC, e.id DESC`,
        [...filter.params, perPage, offset]
      ),
    ]);
    const counted = Number(count.rows[0]?.total ?? 0);
    const limited = counted > MAX_COUNTED;
    const paginated = paginate(result.rows.map(parseEventFeature), page, perPage, limited ? MAX_COUNTED : counted);
    res.json({
      type: 'FeatureCollection',
      features: paginated.data,
      total: paginated.total,
      total_limitado: limited,
      page: paginated.page,
      per_page: paginated.per_page,
      total_pages: paginated.total_pages,
    });
  } catch (error) { next(error); }
});

router.get('/resumo', cacheMiddleware(undefined, () => 60_000), async (req, res, next) => {
  try {
    const filter = baseWhere(req);
    if (filter.error) { res.status(400).json({ error: filter.error }); return; }

    // Sem filtros (cards de KPI): lê a linha pré-calculada por
    // refresh_monitor_resumo() ao fim de cada importação, sem varrer os eventos.
    if (!filter.where.length) {
      const snapshot = await query<any>(
        `SELECT total, por_tipo, por_status, por_prioridade, por_bioma, atualizado_em
         FROM monitor_resumo WHERE id = 1`
      );
      const row = snapshot.rows[0];
      if (row) {
        res.json({ total: Number(row.total), por_tipo: row.por_tipo, por_status: row.por_status,
          por_prioridade: row.por_prioridade, por_bioma: row.por_bioma, atualizado_em: row.atualizado_em });
        return;
      }
    }

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
      por_prioridade: grouped('nivel_prioridade'), por_bioma: grouped('bioma'), atualizado_em: null });
  } catch (error) { next(error); }
});

// --- Tiles MVT dos focos de calor (ícone de fogo no mapa) ---
// Margem para o ícone não ser cortado na borda entre tiles vizinhos.
const FOCO_TILE_BUFFER = 64;
// Abaixo deste zoom os focos são agrupados numa grade (~32 células por tile):
// 30 dias são ~700 mil pontos e um tile do Brasil inteiro ficaria pesado demais.
const FOCO_CLUSTER_MAX_ZOOM = 8;
const FOCO_CLUSTER_CELLS_PER_TILE = 32;
const FOCO_MAX_DIAS = 30;
const FOCO_DEFAULT_DIAS = 3;

function isValidTile(z: number, x: number, y: number): boolean {
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 20) return false;
  const max = 2 ** z;
  return x >= 0 && x < max && y >= 0 && y < max;
}

// GET /api/monitoramento/focos/tiles/:z/:x/:y.mvt?dias=3 — camada "foco".
// A janela é contada a partir do foco mais recente no banco (não de hoje):
// sem coleta diária, "últimas 24 h" ficaria vazio.
// Propriedades: id (do foco, ou de um deles no grupo), n (focos no grupo), frp (MW, máximo).
router.get('/focos/tiles/:z/:x/:y.mvt', async (req, res, next) => {
  try {
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    if (!isValidTile(z, x, y)) { res.status(400).json({ error: 'Coordenadas de tile inválidas' }); return; }
    const diasRaw = getParam(req.query.dias);
    const dias = diasRaw === undefined ? FOCO_DEFAULT_DIAS : Number(diasRaw);
    if (!Number.isInteger(dias) || dias < 1 || dias > FOCO_MAX_DIAS) {
      res.status(400).json({ error: `dias deve ser um inteiro entre 1 e ${FOCO_MAX_DIAS}` });
      return;
    }

    const key = `route:/api/monitoramento/focos/tiles/${z}/${x}/${y}?d=${dias}`;
    const cached = getTileCache(key);
    if (cached) { sendFocoTile(res, cached); return; }

    const conditions = [
      `e.tipo_evento_codigo = 'foco_calor'`,
      `e.data_observacao >= (SELECT DATE_SUB(MAX(m.data_observacao), INTERVAL ? DAY)
                             FROM monitor_evento m WHERE m.tipo_evento_codigo = 'foco_calor')`,
    ];
    const params: unknown[] = [dias];
    const envelope = tileEnvelope(z, x, y, FOCO_TILE_BUFFER);
    if (envelope) { conditions.push(`MBRIntersects(e.geom, ${ENVELOPE_SQL})`); params.push(envelope); }
    const where = `WHERE ${conditions.join(' AND ')}`;

    let rows: { id: number; lon: number; lat: number; n: number; frp: number | null }[];
    if (z < FOCO_CLUSTER_MAX_ZOOM) {
      const cell = 360 / 2 ** z / FOCO_CLUSTER_CELLS_PER_TILE;
      ({ rows } = await query<any>(
        `SELECT MIN(e.id) AS id, AVG(ST_Longitude(e.geom)) AS lon, AVG(ST_Latitude(e.geom)) AS lat,
                COUNT(*) AS n, MAX(e.frp_mw) AS frp
         FROM monitor_evento e ${where}
         GROUP BY FLOOR(ST_Longitude(e.geom) / ?), FLOOR(ST_Latitude(e.geom) / ?)`,
        [...params, cell, cell]
      ));
    } else {
      ({ rows } = await query<any>(
        `SELECT e.id, ST_Longitude(e.geom) AS lon, ST_Latitude(e.geom) AS lat, 1 AS n, e.frp_mw AS frp
         FROM monitor_evento e ${where}`,
        params
      ));
    }

    const features: TileFeature[] = rows.map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(r.lon), Number(r.lat)] },
      properties: { id: Number(r.id), n: Number(r.n), frp: r.frp === null ? null : Number(r.frp) },
    }));
    const buffer = encodeTile('foco', features, z, x, y, FOCO_TILE_BUFFER);
    setTileCache(key, buffer);
    sendFocoTile(res, buffer);
  } catch (error) { next(error); }
});

function sendFocoTile(res: any, buffer: Buffer): void {
  res.set('Content-Type', 'application/vnd.mapbox-vector-tile');
  // Curto: a janela anda a cada importação de focos.
  res.set('Cache-Control', 'public, max-age=600');
  res.send(buffer);
}

router.get('/fontes', cacheMiddleware(undefined, () => 30_000), async (_req, res, next) => {
  try {
    const { rows } = await query<any>(
      `SELECT f.id, f.codigo, f.nome, f.orgao, f.produto, f.formato,
              f.camada_wfs, f.crs_origem, f.frequencia_minutos, f.ativo,
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
