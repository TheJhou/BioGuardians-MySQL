// vt-pbf não publica tipos. Só o que o backend usa (src/mvt.ts).
declare module 'vt-pbf' {
  import type { Tile } from 'geojson-vt';

  interface VtPbf {
    fromGeojsonVt(layers: Record<string, Tile>, options?: { version?: number; extent?: number }): Uint8Array;
  }

  const vtpbf: VtPbf;
  export default vtpbf;
}
