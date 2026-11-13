import { useState, useEffect, useCallback, useMemo } from 'react';
import MapView from '../components/MapView.js';
import OccurrencePanel from '../components/OccurrencePanel.js';
import AreaPanel from '../components/AreaPanel.js';
import DropdownSelect from '../components/DropdownSelect.js';
import SpeciesSearch from '../components/SpeciesSearch.js';
import GlowButton from '../components/GlowButton.js';
import CosmicToggle from '../components/CosmicToggle.js';
import FocoPanel, { FireGlyph } from '../components/FocoPanel.js';
import {
  FONTE_LABELS, FONTE_OPTIONS, CATEGORY_OPTIONS,
  CATEGORY_COLORS, UC_CATEGORY_COLORS, UC_CATEGORY_LABELS, FOCO_DIAS_OPTIONS,
} from '../constants/index.js';
import { api } from '../api/client.js';
import type {
  Especie, OcorrenciaProperties, OcorrenciaTileProperties, AreaTileProperties, EspecieEmArea,
  FocoTileProperties, MonitorEventDetail,
} from '../types/index.js';

interface MapFilters {
  categoria?: string;
  fonte?: string;
}

interface MapLayers {
  unidades: boolean;
  ocorrencias: boolean;
  focos: boolean;
}

interface SelectedEspecie {
  id: number;
  nome: string;
}

const defaultFilters: MapFilters = {};
const defaultLayers: MapLayers = { unidades: true, ocorrencias: true, focos: true };
const DEFAULT_FOCOS_DIAS = 3;

const fonteOptions = FONTE_OPTIONS.map((f) => ({ value: f, label: FONTE_LABELS[f] || f }));
const focosDiasOptions = FOCO_DIAS_OPTIONS.map((d) => ({
  value: String(d),
  label: d === 1 ? 'Último dia' : `Últimos ${d} dias`,
}));
const categoriaOptions = CATEGORY_OPTIONS.map((c) => ({ value: c.codigo, label: c.nome }));

// Rótulos curtos para caber na barra lateral; as cores vêm das mesmas
// constantes que o MapView usa para pintar polígonos e pontos.
const LEGEND_CATEGORY_LABELS: [code: string, label: string][] = [
  ['CR', 'CR — Criticamente em Perigo'],
  ['EN', 'EN — Entrando em Extinção'],
  ['VU', 'VU — Alto Risco'],
  ['NT', 'NT — Em Ameaça'],
  ['LC', 'LC — Sem Risco'],
  ['DD', 'DD — Sem Dados'],
  ['NE', 'NE — Não Avaliada'],
];

function MapLegend() {
  return (
    <div className="map-legend">
      <h4>Legenda</h4>
      <div className="legend-section">
        {/* O mapa pinta as UCs pela categoria SNUC (categoria_uc), não pela esfera */}
        <span className="legend-section-title">Unidades de Conservação</span>
        {Object.entries(UC_CATEGORY_COLORS).map(([code, color]) => (
          <div className="legend-item" key={code}>
            <span className="legend-dot" style={{ background: color }}></span> {UC_CATEGORY_LABELS[code] ?? code}
          </div>
        ))}
      </div>
      <div className="legend-section">
        <span className="legend-section-title">Ocorrências por Categoria</span>
        {LEGEND_CATEGORY_LABELS.map(([code, label]) => (
          <div className="legend-item" key={code}>
            <span className="legend-dot" style={{ background: CATEGORY_COLORS[code] }}></span> {label}
          </div>
        ))}
      </div>
      <div className="legend-section">
        <span className="legend-section-title">Monitoramento</span>
        <div className="legend-item">
          <FireGlyph size={16} /> Foco de calor (INPE); ícone maior = vários focos
        </div>
      </div>
    </div>
  );
}

export default function MapPage() {
  const [draft, setDraft] = useState<MapFilters>(defaultFilters);
  const [applied, setApplied] = useState<MapFilters>(defaultFilters);
  const [layers, setLayers] = useState<MapLayers>(defaultLayers);
  const [showFilters, setShowFilters] = useState(false);
  const [showLegend, setShowLegend] = useState(false);

  // Multi-seleção de espécies
  const [selectedEspecies, setSelectedEspecies] = useState<SelectedEspecie[]>([]);
  const [searchResetKey, setSearchResetKey] = useState(0);

  // Painéis inferiores
  const [selectedOcorrencia, setSelectedOcorrencia] = useState<OcorrenciaProperties | null>(null);
  const [selectedArea, setSelectedArea] = useState<{ id: number; nome: string } | null>(null);
  const [selectedAreaSpecies, setSelectedAreaSpecies] = useState<EspecieEmArea[]>([]);
  const [selectedFoco, setSelectedFoco] = useState<MonitorEventDetail | null>(null);
  const [focosDias, setFocosDias] = useState(DEFAULT_FOCOS_DIAS);

  useEffect(() => {
    if (!selectedArea) {
      setSelectedAreaSpecies([]);
      return;
    }
    api.getEspeciesEmArea(selectedArea.id)
      .then(setSelectedAreaSpecies)
      .catch(() => setSelectedAreaSpecies([]));
  }, [selectedArea?.id]);

  const handleClear = () => {
    setDraft(defaultFilters);
    setApplied(defaultFilters);
    setLayers(defaultLayers);
    setFocosDias(DEFAULT_FOCOS_DIAS);
    setSelectedEspecies([]);
    setSelectedOcorrencia(null);
    setSelectedArea(null);
    setSelectedFoco(null);
    setSearchResetKey((k) => k + 1);
  };

  // Chips aplicam na hora — sem depender do botão "Aplicar Filtros"
  const applyNow = (patch: Partial<MapFilters>) => {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      setApplied(next);
      return next;
    });
  };

  const addEspecie = (especie: Especie) => {
    setSelectedEspecies((prev) => {
      if (prev.some((e) => e.id === especie.id)) return prev;
      return [...prev, { id: especie.id, nome: especie.nome_popular || especie.nome_cientifico }];
    });
  };

  const removeEspecie = (id: number) => {
    setSelectedEspecies((prev) => prev.filter((e) => e.id !== id));
  };

  const handleSelectFoco = useCallback((tile: FocoTileProperties) => {
    setSelectedArea(null);
    setSelectedOcorrencia(null);
    api.getMonitoramentoEvento(tile.id)
      .then(setSelectedFoco)
      .catch(() => setSelectedFoco(null));
  }, []);

  const handleSelectOcorrencia = useCallback((tile: OcorrenciaTileProperties) => {
    setSelectedArea(null);
    setSelectedFoco(null);
    api.getOcorrencia(tile.id)
      .then(setSelectedOcorrencia)
      .catch(() => setSelectedOcorrencia(null));
  }, []);

  const handleSelectArea = useCallback((tile: AreaTileProperties) => {
    setSelectedOcorrencia(null);
    setSelectedFoco(null);
    setSelectedArea({ id: tile.id, nome: '' });
    api.getAreaInfo(tile.id)
      .then((info) => setSelectedArea((cur) => (cur?.id === info.id ? { ...cur, nome: info.nome } : cur)))
      .catch(() => {});
  }, []);

  const selectedEspecieIds = useMemo(
    () => selectedEspecies.map((e) => e.id),
    [selectedEspecies]
  );

  return (
    <div className="map-page container">
      <div className="map-content">
        <aside className={`map-sidebar ${showFilters ? 'map-sidebar--open' : ''}`}>
          <h3 className="sidebar-title">Filtros</h3>

          {/* Buscar espécie — multi-seleção com chips removíveis */}
          <div className="filter-group filter-group--full">
            <label className="filter-label">Buscar espécie</label>
            <SpeciesSearch
              key={searchResetKey}
              onSelect={addEspecie}
            />
            {selectedEspecies.length > 0 && (
              <div className="selected-species-chips">
                {selectedEspecies.map((e) => (
                  <span key={e.id} className="species-chip">
                    {e.nome}
                    <button
                      className="species-chip-remove"
                      onClick={() => removeEspecie(e.id)}
                      aria-label={`Remover ${e.nome}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Fonte e Classificação na mesma linha */}
          <div className="filter-row">
            <div className="filter-group">
              <label className="filter-label">Fonte</label>
              <DropdownSelect
                options={fonteOptions}
                selected={draft.fonte ?? null}
                onSelect={(v) => applyNow({ fonte: v ?? undefined })}
                placeholder="Todas"
              />
            </div>
            <div className="filter-group">
              <label className="filter-label">Classificação</label>
              <DropdownSelect
                options={categoriaOptions}
                selected={draft.categoria ?? null}
                onSelect={(v) => applyNow({ categoria: v ?? undefined })}
                placeholder="Todas"
              />
            </div>
          </div>

          {/* Camadas — toggles do tipo chave na mesma linha */}
          <div className="filter-group filter-group--full">
            <label className="filter-label">Camadas</label>
            <div className="toggle-row">
              <div className="toggle-item">
                <span className="toggle-text">Unidades de Conservação</span>
                <CosmicToggle
                  checked={layers.unidades}
                  onChange={(v) => setLayers({ ...layers, unidades: v })}
                />
              </div>
              <div className="toggle-item">
                <span className="toggle-text">Ocorrências</span>
                <CosmicToggle
                  checked={layers.ocorrencias}
                  onChange={(v) => setLayers({ ...layers, ocorrencias: v })}
                />
              </div>
              <div className="toggle-item">
                <span className="toggle-text">Focos de calor</span>
                <CosmicToggle
                  checked={layers.focos}
                  onChange={(v) => {
                    setLayers({ ...layers, focos: v });
                    if (!v) setSelectedFoco(null);
                  }}
                />
              </div>
            </div>
          </div>

          {layers.focos && (
            <div className="filter-group filter-group--full">
              <label className="filter-label">Período dos focos</label>
              <DropdownSelect
                options={focosDiasOptions}
                selected={String(focosDias)}
                onSelect={(v) => setFocosDias(v ? Number(v) : DEFAULT_FOCOS_DIAS)}
                placeholder={`Últimos ${DEFAULT_FOCOS_DIAS} dias`}
              />
            </div>
          )}

          <GlowButton className="map-clear-btn" onClick={handleClear}>
            Limpar
          </GlowButton>

          <MapLegend />
        </aside>

        <div className="map-filters-bar">
          <button
            className={`map-filters-toggle ${showFilters ? 'active' : ''}`}
            type="button"
            onClick={() => { setShowFilters((s) => !s); setShowLegend(false); }}
          >
            {showFilters ? 'Sair' : 'Ver filtros'}
          </button>
          <button
            className={`map-legend-toggle ${showLegend ? 'active' : ''}`}
            type="button"
            onClick={() => { setShowLegend((s) => !s); setShowFilters(false); }}
          >
            {showLegend ? 'Sair' : 'Ver legenda'}
          </button>
        </div>

        <div className={`map-legend-panel ${showLegend ? 'map-legend-panel--open' : ''}`}>
          <MapLegend />
        </div>

        <div className="map-wrapper">
          <MapView
            filters={applied}
            layers={layers}
            selectedEspecieIds={selectedEspecieIds}
            focosDias={focosDias}
            onSelectFoco={handleSelectFoco}
            onSelectOcorrencia={handleSelectOcorrencia}
            onSelectArea={handleSelectArea}
          />

          {selectedFoco && (
            <FocoPanel foco={selectedFoco} onClose={() => setSelectedFoco(null)} />
          )}

          {selectedOcorrencia && (
            <OccurrencePanel
              ocorrencia={selectedOcorrencia}
              onClose={() => setSelectedOcorrencia(null)}
            />
          )}

          {selectedArea && (
            <AreaPanel
              areaId={selectedArea.id}
              areaName={selectedArea.nome}
              species={selectedAreaSpecies}
              onClose={() => {
                setSelectedArea(null);
                setSelectedAreaSpecies([]);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
