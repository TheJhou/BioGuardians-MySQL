import { FOCO_CALOR_COLORS } from '../constants/index.js';
import { FIRE_INNER_PATH, FIRE_OUTER_PATH } from '../lib/fireIcon.js';
import type { MonitorEventDetail } from '../types/index.js';

interface FocoPanelProps {
  foco: MonitorEventDetail;
  onClose: () => void;
}

function formatDate(value: string | null): string {
  if (!value) return 'N/A';
  const iso = value.replace(' ', 'T');
  const parsed = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('pt-BR');
}

export function FireGlyph({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={FIRE_OUTER_PATH} fill={FOCO_CALOR_COLORS.chama} stroke={FOCO_CALOR_COLORS.contorno} strokeWidth={1.6} strokeLinejoin="round" />
      <path d={FIRE_INNER_PATH} fill={FOCO_CALOR_COLORS.miolo} />
    </svg>
  );
}

export default function FocoPanel({ foco, onClose }: FocoPanelProps) {
  const p = foco.properties;
  const coords = foco.geometry?.type === 'Point' ? foco.geometry.coordinates as number[] : null;
  return (
    <div className="map-bottom-panel open">
      <button className="bottom-panel-close" onClick={onClose} aria-label="Fechar">
        ×
      </button>
      <div className="bottom-panel-content">
        <div className="bottom-panel-media">
          <div className="bottom-panel-img-placeholder"><FireGlyph /></div>
        </div>
        <div className="bottom-panel-body">
          <h4 className="bottom-panel-title">Foco de calor</h4>
          <p className="bottom-panel-subtitle">
            {[p.municipio, p.estado_uf, p.bioma].filter(Boolean).join(' · ') || 'Localização sem referência administrativa'}
          </p>
          <div className="bottom-panel-meta">
            <span><strong>Observado:</strong> {formatDate(p.data_observacao)}</span>
            <span><strong>Satélite:</strong> {p.satelite || 'N/A'}</span>
            <span><strong>FRP:</strong> {p.frp_mw === null ? 'N/A' : `${p.frp_mw} MW`}</span>
            <span><strong>Risco de fogo:</strong> {p.risco_fogo ?? 'N/A'}</span>
            {foco.unidades_conservacao.length > 0 && (
              <span><strong>UC:</strong> {foco.unidades_conservacao.map((uc) => uc.nome).join(', ')}</span>
            )}
            <span><strong>Fonte:</strong> {p.fonte_nome}</span>
            {coords && <span>{coords[1].toFixed(4)}, {coords[0].toFixed(4)}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
