import { logger } from './telemetry/logger.js';

// BBox do Brasil (lon/lat) — cobre o viewport inicial do mapa.
const BRAZIL_BBOX = { minLon: -73.99, minLat: -33.75, maxLon: -34.79, maxLat: 5.27 };

// Zooms caros (tiles grandes, muita geometria). z>=6 é barato por natureza.
// Só ocorrências: tiles de áreas são persistidos na tabela area_tile,
// não dependem mais de cache em memória.
const WARMUP_ZOOMS = [3, 4, 5];
const CONCURRENCY = 4;

function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

function buildTileUrls(): string[] {
  const urls: string[] = [];
  for (const z of WARMUP_ZOOMS) {
    const xMin = lonToTileX(BRAZIL_BBOX.minLon, z);
    const xMax = lonToTileX(BRAZIL_BBOX.maxLon, z);
    const yMin = latToTileY(BRAZIL_BBOX.maxLat, z);
    const yMax = latToTileY(BRAZIL_BBOX.minLat, z);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        urls.push(`/api/ocorrencias/tiles/${z}/${x}/${y}.mvt`);
      }
    }
  }
  return urls;
}

// Pré-aquece o tileCache batendo nos próprios endpoints em background.
// Best-effort: falhas são ignoradas, não bloqueia o listen.
export function warmupTileCache(port: number): void {
  const urls = buildTileUrls();
  const base = `http://localhost:${port}`;
  const start = Date.now();

  setImmediate(async () => {
    let done = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      let url: string | undefined;
      while ((url = urls.pop()) !== undefined) {
        try {
          await fetch(`${base}${url}`);
          done++;
        } catch {
          // ignora — warmup não deve derrubar o boot
        }
      }
    });
    await Promise.all(workers);
    logger.info('tile_warmup_done', { tiles: done, duration_ms: Date.now() - start });
  });
}
