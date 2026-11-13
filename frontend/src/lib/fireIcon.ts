import { FOCO_CALOR_COLORS } from '../constants/index.js';

// Ícone de fogo dos focos de calor, desenhado num canvas (sem arquivo de
// imagem para baixar). Caminhos em viewBox 24×24, os mesmos da legenda.
export const FIRE_OUTER_PATH =
  'M12 1.5c1 3.6-.4 5.6-2 7.6C8.4 11 6.5 13 6.5 16.2A5.5 5.5 0 0 0 12 21.7a5.5 5.5 0 0 0 5.5-5.5' +
  'c0-2.9-1.6-5-2.8-6.4.1 1.7-.5 2.9-1.6 3.5.4-3.1-.1-6.5-1.1-9.8z';
export const FIRE_INNER_PATH =
  'M12 12.5c.4 1.6-.3 2.4-1 3.2-.6.7-1 1.4-1 2.4a2 2 0 0 0 4 0c0-1.5-.9-2.4-1.3-3 0 .7-.3 1.1-.7 1.3.3-1.4.2-2.7 0-3.9z';

export const FIRE_ICON_ID = 'foco-fogo';
const SIZE = 24;
const PIXEL_RATIO = 2;

/** Imagem RGBA do ícone, para `map.addImage(FIRE_ICON_ID, img, { pixelRatio: 2 })`. */
export function createFireIcon(): { width: number; height: number; data: Uint8Array } | null {
  const px = SIZE * PIXEL_RATIO;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
  ctx.lineJoin = 'round';
  const outer = new Path2D(FIRE_OUTER_PATH);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = FOCO_CALOR_COLORS.contorno;
  ctx.stroke(outer);
  ctx.fillStyle = FOCO_CALOR_COLORS.chama;
  ctx.fill(outer);
  ctx.fillStyle = FOCO_CALOR_COLORS.miolo;
  ctx.fill(new Path2D(FIRE_INNER_PATH));

  const { data } = ctx.getImageData(0, 0, px, px);
  return { width: px, height: px, data: new Uint8Array(data.buffer) };
}

/** Registra o ícone no mapa (idempotente). Chamar no load e em `styleimagemissing`. */
export function ensureFireIcon(map: { hasImage(id: string): boolean; addImage(id: string, img: any, opts?: any): void }): void {
  if (map.hasImage(FIRE_ICON_ID)) return;
  const icon = createFireIcon();
  if (icon) map.addImage(FIRE_ICON_ID, icon, { pixelRatio: PIXEL_RATIO });
}
