// Pré-gera os tiles MVT de áreas protegidas e grava no banco
// (tabela area_tile). Uso:
//
//   npm run generate-area-tiles            → z3–z6 (default)
//   npm run generate-area-tiles -- 3 8     → z3–z8
//
// Idempotente (upsert por z/x/y). Só gera tiles cuja bounding box
// cobre a extensão real dos dados — tiles vazios fora do bbox nem
// entram na fila.
import { pool, query } from '../src/db/pool.js';
import { generateAreaTile, storeAreaTile } from '../src/tileStore.js';

const MIN_ZOOM = parseInt(process.argv[2] ?? '3', 10);
const MAX_ZOOM = parseInt(process.argv[3] ?? '6', 10);
const CONCURRENCY = 4;

function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

async function main(): Promise<void> {
  // O MySQL não tem ST_Extent e ST_Envelope não aceita SRID 4326:
  // envelope de cada UC em SRID 0 (coordenadas continuam lon/lat), e a
  // extensão total é calculada aqui.
  const { rows } = await query<{ envelope: { coordinates: unknown } }>(
    'SELECT ST_AsGeoJSON(ST_Envelope(ST_SRID(geom, 0))) AS envelope FROM area_protegida'
  );
  const bbox = { min_lon: Infinity, min_lat: Infinity, max_lon: -Infinity, max_lat: -Infinity };
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      const [lon, lat] = c as number[];
      bbox.min_lon = Math.min(bbox.min_lon, lon);
      bbox.max_lon = Math.max(bbox.max_lon, lon);
      bbox.min_lat = Math.min(bbox.min_lat, lat);
      bbox.max_lat = Math.max(bbox.max_lat, lat);
    } else if (Array.isArray(c)) {
      c.forEach(visit);
    }
  };
  rows.forEach((r) => visit(r.envelope.coordinates));
  if (rows.length === 0) {
    console.log('area_protegida vazia — nada a gerar.');
    return;
  }

  // Margem pequena pra garantir que polígonos na borda entrem.
  const pad = 0.01;
  const tiles: Array<[number, number, number]> = [];
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    const xMin = lonToTileX(bbox.min_lon - pad, z);
    const xMax = lonToTileX(bbox.max_lon + pad, z);
    const yMin = latToTileY(bbox.max_lat + pad, z);
    const yMax = latToTileY(bbox.min_lat - pad, z);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        tiles.push([z, x, y]);
      }
    }
  }

  console.log(`Gerando ${tiles.length} tiles (z${MIN_ZOOM}–z${MAX_ZOOM})...`);
  const start = Date.now();
  let done = 0;
  let bytes = 0;
  let errors = 0;

  const queue = [...tiles];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      let t: [number, number, number] | undefined;
      while ((t = queue.pop()) !== undefined) {
        try {
          const buffer = await generateAreaTile(t[0], t[1], t[2]);
          await storeAreaTile(t[0], t[1], t[2], buffer);
          done++;
          bytes += buffer.length;
          if (done % 100 === 0) console.log(`  ${done}/${tiles.length}`);
        } catch (err) {
          errors++;
          console.error(`  tile ${t.join('/')}: ${err instanceof Error ? err.message : err}`);
        }
      }
    })
  );

  console.log(
    `Concluído: ${done} tiles (${(bytes / 1024).toFixed(0)}KB), ` +
    `${errors} erros, ${((Date.now() - start) / 1000).toFixed(1)}s`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
