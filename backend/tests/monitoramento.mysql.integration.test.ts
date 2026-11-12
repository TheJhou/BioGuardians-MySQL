import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import { execute, pool, query } from '../src/db/pool.js';
import { importDeterWfs } from '../src/monitoramento/deter.js';
import { importInpeCsv } from '../src/monitoramento/ingestion.js';
import monitoramentoRoutes from '../src/routes/monitoramento.js';

let server: Server | undefined;
const executionIds: number[] = [];
const tempFiles: string[] = [];
let sourceId = 0;
let deterSourceId = 0;
let areaId = 0;
let externalIds: string[] = [];
let deterExternalId = '';

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  if (sourceId && externalIds.length) {
    await query('DELETE FROM monitor_evento WHERE fonte_id = ? AND id_externo IN (?)', [sourceId, externalIds]);
  }
  if (deterSourceId && deterExternalId) {
    await query('DELETE FROM monitor_evento WHERE fonte_id = ? AND id_externo = ?', [deterSourceId, deterExternalId]);
  }
  if (executionIds.length) await query('DELETE FROM monitor_execucao WHERE id IN (?)', [executionIds]);
  if (areaId) {
    await execute('DELETE FROM area_protegida WHERE id = ?', [areaId]);
    await query("DELETE FROM log_auditoria WHERE tabela = 'area_protegida' AND registro_id = ?", [areaId]);
  }
  await Promise.all(tempFiles.map((file) => unlink(file).catch(() => undefined)));
  await pool.end();
});

test('INPE CSV e DETER WFS criam eventos espaciais; GET os devolve e reimportações preservam atendimento', async () => {
  const suffix = randomUUID();
  const ids = [`integration-${suffix}-1`, `integration-${suffix}-2`];
  externalIds = ids;
  const fixturePath = new URL('./fixtures/inpe_focos_sample.csv', import.meta.url);
  const csv = (await readFile(fixturePath, 'utf8'))
    .replaceAll('b19636a6-b8b6-37eb-8da0-0d1648486079', ids[0])
    .replaceAll('725832b2-3fda-3c04-8ff6-b7983797f211', ids[1]);
  const inpeFile = join(tmpdir(), `bioguardians-monitor-${suffix}.csv`);
  tempFiles.push(inpeFile);
  await (await import('node:fs/promises')).writeFile(inpeFile, csv, 'utf8');

  const sources = await query<{ id: number }>('SELECT id FROM monitor_fonte WHERE codigo = ?', ['inpe_queimadas_diario_br']);
  assert.ok(sources.rows[0], 'fonte INPE deve existir após aplicar as migrations');
  sourceId = sources.rows[0].id;
  const deterSource = await query<{ id: number }>(
    'SELECT id FROM monitor_fonte WHERE codigo = ?',
    ['terrabrasilis_deter_amazonia_wfs']
  );
  assert.ok(deterSource.rows[0], 'fonte DETER Amazônia deve existir após aplicar as migrations');
  deterSourceId = deterSource.rows[0].id;

  const area = await execute(
    `INSERT INTO area_protegida (nome, categoria_uc, esfera, geom)
     VALUES (?, 'protecao_integral', 'federal',
       ST_GeomFromText(?, 4326, 'axis-order=long-lat'))`,
    [`MONITOR-INTEGRATION-${suffix}`, 'MULTIPOLYGON(((-54 -12, -53 -12, -53 -11, -54 -11, -54 -12)))']
  );
  areaId = area.insertId;

  const first = await importInpeCsv({
    sourceCode: 'inpe_queimadas_diario_br',
    date: '2024-09-24',
    file: inpeFile,
  });
  if (first.executionId) executionIds.push(first.executionId);
  assert.equal(first.inserted, 2);
  assert.equal(first.updated, 0);
  assert.equal(first.ignored, 1);
  assert.equal(first.rejected, 1);

  const stored = await query<any>(
    `SELECT id, id_externo, municipio_codigo_ibge, ST_SRID(geom) AS srid
     FROM monitor_evento WHERE fonte_id = ? AND id_externo IN (?) ORDER BY id_externo`,
    [sourceId, ids]
  );
  assert.equal(stored.rows.length, 2);
  assert.ok(stored.rows.every((row) => Number(row.srid) === 4326));
  const target = stored.rows.find((row) => row.id_externo === ids[0]);
  assert.ok(target);

  const attendance = await query<any>(
    `SELECT a.status, COUNT(h.id) AS history_count
     FROM monitor_atendimento a
     LEFT JOIN monitor_atendimento_historico h ON h.evento_id = a.evento_id
     WHERE a.evento_id = ? GROUP BY a.evento_id, a.status`,
    [target.id]
  );
  assert.equal(attendance.rows[0].status, 'novo');
  assert.equal(Number(attendance.rows[0].history_count), 1);
  const areaLink = await query<any>(
    'SELECT tipo_relacao FROM monitor_evento_uc WHERE evento_id = ? AND area_id = ?',
    [target.id, areaId]
  );
  assert.equal(areaLink.rows[0]?.tipo_relacao, 'contem_ponto');

  const deterId = `deter_amz.integration-${suffix}_curr`;
  deterExternalId = deterId;
  const deterFixture = await readFile(new URL('./fixtures/terrabrasilis_deter_sample.geojson', import.meta.url), 'utf8');
  const deterFile = join(tmpdir(), `bioguardians-deter-${suffix}.geojson`);
  tempFiles.push(deterFile);
  await (await import('node:fs/promises')).writeFile(deterFile, deterFixture.replaceAll('integration-template', `integration-${suffix}`), 'utf8');
  const deterImport = await importDeterWfs({
    sourceCode: 'terrabrasilis_deter_amazonia_wfs',
    since: '2024-09-01',
    file: deterFile,
  });
  if (deterImport.executionId) executionIds.push(deterImport.executionId);
  assert.equal(deterImport.inserted, 1);
  assert.equal(deterImport.ignored, 1);
  assert.equal(deterImport.rejected, 1);
  const deterEvent = await query<any>(
    `SELECT id, tipo_evento_codigo, classe_fonte, area_alerta_ha,
            municipio_codigo_ibge, ST_GeometryType(geom) AS geometry_type,
            ST_SRID(geom) AS srid
     FROM monitor_evento WHERE fonte_id = ? AND id_externo = ?`,
    [deterSourceId, deterId]
  );
  assert.equal(deterEvent.rows[0]?.tipo_evento_codigo, 'alerta_deter');
  assert.equal(deterEvent.rows[0]?.classe_fonte, 'DESMATAMENTO_CR');
  assert.equal(deterEvent.rows[0]?.geometry_type, 'MULTIPOLYGON');
  assert.equal(Number(deterEvent.rows[0]?.srid), 4326);
  assert.ok(Number(deterEvent.rows[0]?.area_alerta_ha) > 0);
  assert.equal(deterEvent.rows[0]?.municipio_codigo_ibge, '5105622');
  const deterAreaLink = await query<any>(
    'SELECT tipo_relacao, intersecao_ha FROM monitor_evento_uc WHERE evento_id = ? AND area_id = ?',
    [deterEvent.rows[0].id, areaId]
  );
  assert.equal(deterAreaLink.rows[0]?.tipo_relacao, 'intersecta_poligono');
  assert.ok(Number(deterAreaLink.rows[0]?.intersecao_ha) > 0);

  const app = express();
  app.use('/api/monitoramento', monitoramentoRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/api/monitoramento`;

  const listResponse = await fetch(`${baseUrl}/eventos?fonte=inpe_queimadas_diario_br&bbox=-54,-12,-53,-11`);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json() as any;
  assert.equal(list.features.length, 1);
  assert.equal(list.features[0].geometry.coordinates[0], -53.893);
  assert.equal(list.features[0].geometry.coordinates[1], -11.233);

  const detailResponse = await fetch(`${baseUrl}/eventos/${target.id}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json() as any;
  assert.equal(detail.atendimento.status, 'novo');
  assert.equal(detail.historico_atendimento.length, 1);
  assert.equal(detail.properties.municipio_codigo_ibge, '5105622');

  const runResponse = await fetch(`${baseUrl}/execucoes/${first.executionId}`);
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json() as any;
  assert.equal(run.status, 'parcial');
  assert.equal(run.registros_novos, 2);
  assert.equal(run.registros_rejeitados, 1);
  assert.equal(run.parametros.fonte, 'inpe_queimadas_diario_br');
  assert.equal(run.parametros.data, '2024-09-24');

  const summaryResponse = await fetch(`${baseUrl}/resumo?fonte=inpe_queimadas_diario_br&desde=2024-09-24&ate=2024-09-24`);
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json() as any;
  assert.equal(summary.total, 2);
  assert.equal(summary.por_status.novo, 2);

  // Sem filtros, /resumo lê monitor_resumo, recalculado por finishExecution.
  const kpiResponse = await fetch(`${baseUrl}/resumo`);
  assert.equal(kpiResponse.status, 200);
  const kpi = await kpiResponse.json() as any;
  const liveTotal = await query<any>('SELECT COUNT(*) AS total FROM monitor_evento');
  assert.equal(kpi.total, Number(liveTotal.rows[0].total));
  assert.ok(kpi.atualizado_em);

  const cappedResponse = await fetch(`${baseUrl}/eventos?per_page=100&page=101`);
  assert.equal(cappedResponse.status, 400);

  const sourcesResponse = await fetch(`${baseUrl}/fontes`);
  assert.equal(sourcesResponse.status, 200);
  const sourcesPayload = await sourcesResponse.json() as any;
  assert.ok(sourcesPayload.data.some((source: any) => source.codigo === 'inpe_queimadas_diario_br' && source.ativo));
  assert.ok(sourcesPayload.data.some((source: any) => source.codigo === 'terrabrasilis_deter_amazonia_wfs' && source.ativo && source.camada_wfs === 'deter-amz:deter_amz'));
  assert.ok(sourcesPayload.data.some((source: any) => source.codigo === 'terrabrasilis_deter_cerrado_wfs' && source.ativo && source.camada_wfs === 'deter-cerrado-nb:deter_cerrado'));

  const deterDetailResponse = await fetch(`${baseUrl}/eventos/${deterEvent.rows[0].id}`);
  assert.equal(deterDetailResponse.status, 200);
  const deterDetail = await deterDetailResponse.json() as any;
  assert.equal(deterDetail.geometry.type, 'MultiPolygon');
  assert.equal(deterDetail.properties.classe_fonte, 'DESMATAMENTO_CR');
  assert.equal(deterDetail.atendimento.status, 'novo');
  assert.match(deterDetail.historico_atendimento[0].observacao, /TerraBrasilis DETER/);

  await execute(
    `UPDATE monitor_atendimento
     SET status = 'em_andamento', iniciado_em = UTC_TIMESTAMP(6)
     WHERE evento_id = ?`,
    [target.id]
  );
  await execute(
    `INSERT INTO monitor_atendimento_historico
       (evento_id, status_anterior, status_novo, ator, observacao)
     VALUES (?, 'novo', 'em_andamento', 'teste', 'Estado preparado pelo teste de integração')`,
    [target.id]
  );

  const second = await importInpeCsv({
    sourceCode: 'inpe_queimadas_diario_br',
    date: '2024-09-24',
    file: inpeFile,
  });
  if (second.executionId) executionIds.push(second.executionId);
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 2);

  const preserved = await query<any>(
    `SELECT a.status, COUNT(h.id) AS history_count
     FROM monitor_atendimento a
     LEFT JOIN monitor_atendimento_historico h ON h.evento_id = a.evento_id
     WHERE a.evento_id = ? GROUP BY a.evento_id, a.status`,
    [target.id]
  );
  assert.equal(preserved.rows[0].status, 'em_andamento');
  assert.equal(Number(preserved.rows[0].history_count), 2);
});
