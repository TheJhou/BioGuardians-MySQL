import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseCsv } from '../src/monitoramento/csv.js';
import { parseInpeCsv } from '../src/monitoramento/inpe.js';

const fixturePath = fileURLToPath(new URL('./fixtures/inpe_focos_sample.csv', import.meta.url));

test('CSV handles BOM, quoted commas, escaped quotes and embedded newlines', () => {
  const parsed = parseCsv('\uFEFFname,description\r\n"Área, norte","linha 1\nlinha ""2"""\r\n');
  assert.deepEqual(parsed.headers, ['name', 'description']);
  assert.equal(parsed.rows[0].name, 'Área, norte');
  assert.equal(parsed.rows[0].description, 'linha 1\nlinha "2"');
});

test('INPE adapter normalizes GMT, source fields, duplicate IDs and invalid coordinates', async () => {
  const csv = await readFile(fixturePath, 'utf8');
  const parsed = parseInpeCsv(csv);

  assert.equal(parsed.rowsRead, 4);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.duplicatedInFile, 1);
  assert.equal(parsed.rejected.coordenada_fora_do_intervalo, 1);
  assert.equal(parsed.events[0].dataObservacao, '2024-09-24 01:56:10');
  assert.equal(parsed.events[0].precisaoData, 'instante');
  assert.equal(parsed.events[0].longitude, -53.893);
  assert.equal(parsed.events[0].latitude, -11.233);
  assert.equal(parsed.events[0].municipioNome, 'MARCELÂNDIA, NORTE');
  assert.equal(parsed.events[0].municipioCodigoIbge, '5105622');
  assert.equal(parsed.events[0].riscoFogo, 1);
  assert.equal(parsed.events[0].frpMw, 63.5);
  assert.equal(parsed.events[0].idExterno, 'b19636a6-b8b6-37eb-8da0-0d1648486079');
});

test('INPE adapter generates a deterministic key when the source has no ID column', () => {
  const csv = 'Latitude,Longitude,DataHora,Satelite\n-11.233,-53.893,2024/09/24 01:56:10,GOES-16\n';
  const parsed = parseInpeCsv(csv);
  assert.match(parsed.events[0].idExterno, /^sha256:[a-f0-9]{64}$/);
});

test('INPE adapter rejects a CSV with unrelated headers', () => {
  assert.throws(() => parseInpeCsv('name,value\na,b\n'), /sem coluna Latitude/);
});
