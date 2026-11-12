#!/usr/bin/env node
// Converte o backup CSV do banco PostgreSQL antigo (um CSV por tabela, como em
// bioguardians_dados_csv_2026-09-30.zip) num arquivo .sql para o schema MySQL.
//
// Uso:
//   node import_pg_backup.mjs <pasta-dos-csv> <saida.sql> [--repair-ids=27,149,...]
//   mysql --default-character-set=utf8mb4 -u ... -p ... <db> < saida.sql
//
// O SQL gerado:
// - aborta se o banco já tiver espécies, UCs ou ocorrências (só carrega em banco vazio);
// - mantém os ids originais (FKs e URLs continuam valendo);
// - deixa os triggers calcularem geom de ocorrencia/deteccao e ocorrencia_area,
//   e depois acrescenta as ligações ocorrência↔UC do backup que faltarem;
// - o validador do MySQL (Boost) recusa polígonos que o PostGIS/JTS aceitam e
//   não tem ST_MakeValid. As UCs passadas em --repair-ids são corrigidas aqui
//   com JSTS: grade de 1e-7 grau (~1 cm) + buffer(0), sempre como MULTIPOLYGON.
//   Para descobrir os ids, gere sem a opção e rode num MySQL descartável: o SQL
//   lista as UCs recusadas (e não as importa) antes de seguir;
// - troca o log gerado pelos triggers durante a carga pelo log_auditoria do
//   backup (em area_protegida o polígono vira geom_md5 = NULL, como no
//   formato MySQL, que não guarda o polígono no log);
// - chama refresh_dashboard() no fim.
//
// Ignorados: categoria_ameaca, bioma e estado (já vêm da migration 001 com os
// mesmos códigos/ids), cache_metadata (removida no porte) e schema_migrations.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parse } from 'csv-parse/sync';
import WKTReader from 'jsts/org/locationtech/jts/io/WKTReader.js';
import WKTWriter from 'jsts/org/locationtech/jts/io/WKTWriter.js';
import BufferOp from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js';
import GeometryPrecisionReducer from 'jsts/org/locationtech/jts/precision/GeometryPrecisionReducer.js';
import PrecisionModel from 'jsts/org/locationtech/jts/geom/PrecisionModel.js';
import Polygon from 'jsts/org/locationtech/jts/geom/Polygon.js';
import MultiPolygon from 'jsts/org/locationtech/jts/geom/MultiPolygon.js';

const require = createRequire(import.meta.url);
const { escape } = require('../../backend/node_modules/mysql2');

const args = process.argv.slice(2);
const [dir, out] = args.filter((a) => !a.startsWith('--'));
const repairArg = args.find((a) => a.startsWith('--repair-ids='));
const repairIds = new Set(repairArg ? repairArg.split('=')[1].split(',').filter(Boolean).map(Number) : []);
if (!dir || !out) {
  console.error('Uso: node import_pg_backup.mjs <pasta-dos-csv> <saida.sql> [--repair-ids=1,2,3]');
  process.exit(1);
}

const wktReader = new WKTReader();
const wktWriter = new WKTWriter();
const grid = new PrecisionModel(1e7);
let repaired = 0;
function repairWkt(wkt) {
  const fixed = BufferOp.bufferOp(GeometryPrecisionReducer.reduce(wktReader.read(wkt), grid), 0);
  let multi;
  if (fixed instanceof MultiPolygon) multi = fixed;
  else if (fixed instanceof Polygon) multi = fixed.getFactory().createMultiPolygon([fixed]);
  else throw new Error(`reparo gerou ${fixed.getGeometryType()}`);
  const before = wktReader.read(wkt).getArea();
  const delta = Math.abs(multi.getArea() - before) / before;
  if (delta > 0.001) throw new Error(`reparo mudou a área em ${(delta * 100).toFixed(3)}%`);
  repaired++;
  return wktWriter.write(multi);
}

// No dump, NULL vem sem aspas e strings vêm sempre entre aspas.
function read(name) {
  return parse(fs.readFileSync(path.join(dir, name)), {
    columns: true,
    cast: (value, ctx) => (!ctx.quoting && value === 'NULL' ? null : value),
  });
}

const fd = fs.openSync(out, 'w');
const write = (s) => fs.writeSync(fd, s);
const lit = (v) => (v === null || v === undefined ? 'NULL' : escape(v));
const ident = (c) => '`' + c + '`';

// INSERT em lotes que respeitam o max_allowed_packet (64 MB no MySQL 8.4).
function insert(table, rows, columns, { map = (r) => r, maxBytes = 4 << 20, ignore = false } = {}) {
  const head = `INSERT ${ignore ? 'IGNORE ' : ''}INTO ${table} (${columns.map(ident).join(', ')}) VALUES\n`;
  let batch = [];
  let size = 0;
  const flush = () => {
    if (batch.length) write(head + batch.join(',\n') + ';\n');
    batch = [];
    size = 0;
  };
  for (const raw of rows) {
    const r = map(raw);
    const tuple = '(' + columns.map((c) => (r[c] && r[c].sql ? r[c].sql : lit(r[c]))).join(', ') + ')';
    if (size + tuple.length > maxBytes) flush();
    batch.push(tuple);
    size += tuple.length;
  }
  flush();
  console.error(`${table}: ${rows.length}`);
}

const raw = (sql) => ({ sql });

write(`-- Gerado por scripts/data/import_pg_backup.mjs a partir de ${path.basename(path.resolve(dir))}
SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET foreign_key_checks = 0;

-- Aborta (erro "Subquery returns more than 1 row") se o banco não estiver vazio.
SELECT IF(
  (SELECT COUNT(*) FROM especie) + (SELECT COUNT(*) FROM area_protegida) + (SELECT COUNT(*) FROM ocorrencia) = 0,
  'banco vazio, importando',
  (SELECT 1 UNION ALL SELECT 2)
) AS verificacao;

`);

insert('taxon', read('taxon.csv'), ['id', 'nome', 'rank', 'parent_id']);

insert('especie', read('especie.csv'), [
  'id', 'nome_cientifico', 'nome_popular', 'categoria_ameaca', 'categoria_fonte', 'genero_id',
  'descricao', 'imagem_url', 'status', 'criado_em', 'atualizado_em',
]);
insert('especie_bioma', read('especie_bioma.csv'), ['especie_id', 'bioma_id']);
insert('especie_estado', read('especie_estado.csv'), ['especie_id', 'estado_uf']);

// UCs: passam por uma tabela de staging para separar as geometrias inválidas.
// (Tabelas de staging comuns: o MySQL não deixa citar uma TEMPORARY duas vezes
// na mesma consulta.)
write(`
DROP TABLE IF EXISTS _import_stage_area;
CREATE TABLE _import_stage_area (
  id INT PRIMARY KEY, nome VARCHAR(180), categoria_uc VARCHAR(30), esfera VARCHAR(20),
  bioma_id SMALLINT, area_ha DECIMAL(12,2), geom MULTIPOLYGON NOT NULL SRID 4326,
  criado_em DATETIME(6), atualizado_em DATETIME(6)
);
`);
insert('_import_stage_area', read('area_protegida.csv'), [
  'id', 'nome', 'categoria_uc', 'esfera', 'bioma_id', 'area_ha', 'geom', 'criado_em', 'atualizado_em',
], {
  // WKT do PostGIS é lon/lat; o MySQL em SRID 4326 lê lat/lon sem o axis-order.
  map: (r) => {
    const wkt = repairIds.has(Number(r.id)) ? repairWkt(r.geom) : r.geom;
    return { ...r, geom: raw(`ST_GeomFromText(${lit(wkt)}, 4326, 'axis-order=long-lat')`) };
  },
  maxBytes: 8 << 20,
});
console.error(`UCs reparadas: ${repaired}`);

write(`
SELECT id, nome, 'geometria recusada pelo MySQL, nao importada' AS aviso
FROM _import_stage_area WHERE NOT ST_IsValid(ST_SRID(geom, 0)) OR ST_IsEmpty(geom);

INSERT INTO area_protegida (id, nome, categoria_uc, esfera, bioma_id, area_ha, geom, criado_em, atualizado_em)
SELECT id, nome, categoria_uc, esfera, bioma_id, area_ha, geom, criado_em, atualizado_em
FROM _import_stage_area
WHERE ST_IsValid(ST_SRID(geom, 0)) AND NOT ST_IsEmpty(geom)
ORDER BY id;

DROP TABLE _import_stage_area;

`);

// geom é recalculada pelo trigger a partir de lat/lon; o trigger AFTER INSERT
// preenche ocorrencia_area com ST_Contains.
const dummyPoint = raw(`ST_SRID(POINT(0, 0), 4326)`);
insert('ocorrencia', read('ocorrencia.csv'), [
  'id', 'especie_id', 'lat', 'lon', 'geom', 'data_evento', 'fonte', 'base_registro', 'confianca_ia', 'criado_em',
], { map: (r) => ({ ...r, geom: dummyPoint }) });

write(`
SELECT COUNT(*) AS ocorrencia_area_pelos_triggers FROM ocorrencia_area;
`);
// Só acrescenta ligações do backup que o MySQL não calculou (e cujas UCs existem).
write(`
DROP TABLE IF EXISTS _import_stage_oa;
CREATE TABLE _import_stage_oa (ocorrencia_id INT, area_id INT, PRIMARY KEY (ocorrencia_id, area_id));
`);
insert('_import_stage_oa', read('ocorrencia_area.csv'), ['ocorrencia_id', 'area_id']);
write(`
SELECT
  (SELECT COUNT(*) FROM _import_stage_oa) AS ligacoes_backup,
  (SELECT COUNT(*) FROM _import_stage_oa s LEFT JOIN ocorrencia_area oa USING (ocorrencia_id, area_id) WHERE oa.area_id IS NULL) AS so_no_backup,
  (SELECT COUNT(*) FROM ocorrencia_area oa LEFT JOIN _import_stage_oa s USING (ocorrencia_id, area_id) WHERE s.area_id IS NULL) AS so_no_mysql;

INSERT IGNORE INTO ocorrencia_area (ocorrencia_id, area_id)
SELECT s.ocorrencia_id, s.area_id
FROM _import_stage_oa s
JOIN ocorrencia o ON o.id = s.ocorrencia_id
JOIN area_protegida a ON a.id = s.area_id;

DROP TABLE _import_stage_oa;

`);

insert('deteccao_job', read('deteccao_job.csv'), [
  'id', 'bbox', 'data_captura', 'satelite', 'instrumento', 'produto', 'scene_id', 'imagem_url', 'status',
  'source', 'data_dir', 'project_id', 'p_limit', 'total_imagens', 'imagens_processadas', 'total_deteccoes',
  'erro', 'criado_em', 'concluido_em',
]);
insert('imagem_job', read('imagem_job.csv'), [
  'id', 'job_id', 'source', 'source_image_id', 'image_hash', 'path', 'lat', 'lon', 'timestamp', 'camera_id',
  'project_id', 'deployment_id', 'status', 'detection_count', 'error', 'created_at', 'updated_at',
]);
insert('deteccao', read('deteccao.csv'), [
  'id', 'job_id', 'image_job_id', 'especie_id', 'nome_cientifico', 'confianca', 'lat', 'lon', 'geom',
  'bbox_pixel', 'recorte_url', 'metodo_classificacao', 'modelo_ia', 'confianca_ia', 'status', 'criado_em',
], { map: (r) => ({ ...r, geom: dummyPoint }) });
insert('modelo_ml', read('modelo_ml.csv'), [
  'id', 'nome', 'versao', 'tipo', 'caminho', 'acuracia', 'ativo', 'criado_em',
], { map: (r) => ({ ...r, ativo: r.ativo === 't' || r.ativo === 'true' ? 1 : 0 }) });

// Log de auditoria: descarta o que os triggers gravaram nesta carga e
// restaura o histórico do backup.
write(`
DELETE FROM log_auditoria;
`);
const slimGeom = (json) => {
  if (json === null) return null;
  const obj = JSON.parse(json);
  if ('geom' in obj) {
    delete obj.geom;
    obj.geom_md5 = null;
  }
  return JSON.stringify(obj);
};
insert('log_auditoria', read('log_auditoria.csv'), [
  'id', 'tabela', 'operacao', 'registro_id', 'usuario', 'timestamp', 'dados_anteriores', 'dados_novos',
], {
  map: (r) => ({
    ...r,
    dados_anteriores: slimGeom(r.dados_anteriores),
    dados_novos: slimGeom(r.dados_novos),
  }),
});

write(`
SET foreign_key_checks = 1;
CALL refresh_dashboard();

SELECT
  (SELECT COUNT(*) FROM taxon) AS taxon,
  (SELECT COUNT(*) FROM especie) AS especie,
  (SELECT COUNT(*) FROM area_protegida) AS area_protegida,
  (SELECT COUNT(*) FROM ocorrencia) AS ocorrencia,
  (SELECT COUNT(*) FROM ocorrencia_area) AS ocorrencia_area,
  (SELECT COUNT(*) FROM deteccao) AS deteccao,
  (SELECT COUNT(*) FROM imagem_job) AS imagem_job,
  (SELECT COUNT(*) FROM log_auditoria) AS log_auditoria;
`);
fs.closeSync(fd);
console.error(`SQL gravado em ${out}`);
