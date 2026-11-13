import { useState, useCallback, useMemo, memo } from 'react';
import { Map, Source, Layer, NavigationControl } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { api } from '../api/client.js';
import { MAP_DEFAULTS, CATEGORY_COLORS, UC_CATEGORY_COLORS } from '../constants/index.js';
import { ensureFireIcon, FIRE_ICON_ID } from '../lib/fireIcon.js';
import type { OcorrenciaTileProperties, AreaTileProperties, FocoTileProperties } from '../types/index.js';

const MAPTILER_API_KEY = import.meta.env.VITE_MAPTILER_API_KEY || '';

interface MapFilters {
  categoria?: string;
  esfera?: string;
  fonte?: string;
}

interface MapLayers {
  unidades: boolean;
  ocorrencias: boolean;
  focos: boolean;
}

interface MapViewProps {
  filters: MapFilters;
  layers: MapLayers;
  selectedEspecieIds?: number[];
  /** Janela dos focos de calor, em dias a partir do foco mais recente. */
  focosDias: number;
  onSelectFoco?: (foco: FocoTileProperties) => void;
  onSelectOcorrencia?: (ocorrencia: OcorrenciaTileProperties, lngLat: { lng: number; lat: number }) => void;
  onSelectArea?: (area: AreaTileProperties, lngLat: { lng: number; lat: number }) => void;
}

const INITIAL_VIEW = {
  longitude: MAP_DEFAULTS.center.lng,
  latitude: MAP_DEFAULTS.center.lat,
  zoom: MAP_DEFAULTS.zoom,
};

// Fallbacks = mesmas cores de getCategoryColor/getUcCategoryColor (DD e proteção integral)
const occurrenceColorMatch = buildMatchExpression('categoria_ameaca', CATEGORY_COLORS, CATEGORY_COLORS.DD);
const ucColorMatch = buildMatchExpression('categoria_uc', UC_CATEGORY_COLORS, UC_CATEGORY_COLORS.protecao_integral);

function buildMatchExpression(inputProperty: string, pairs: Record<string, string>, fallback: string): any[] {
  const stops = Object.entries(pairs).flatMap(([k, v]) => [k, v]);
  return ['match', ['get', inputProperty], ...stops, fallback];
}

function MapView({
  filters,
  layers,
  selectedEspecieIds,
  focosDias,
  onSelectFoco,
  onSelectOcorrencia,
  onSelectArea,
}: MapViewProps) {
  const [error, setError] = useState<string | null>(null);

  const areaTilesUrl = useMemo(
    () => api.getAreaTilesUrl({ esfera: filters.esfera }),
    [filters.esfera]
  );

  const ocorrenciasTilesUrl = useMemo(
    () => api.getOcorrenciasTilesUrl({
      especie_id: selectedEspecieIds,
      categoria: filters.categoria,
      fonte: filters.fonte,
    }),
    [selectedEspecieIds, filters.categoria, filters.fonte]
  );

  const focosTilesUrl = useMemo(() => api.getFocosTilesUrl({ dias: focosDias }), [focosDias]);
  const focoTiles = useMemo(() => [focosTilesUrl], [focosTilesUrl]);

  // O ícone de fogo é desenhado em canvas e registrado no estilo; se o estilo
  // for recarregado, o MapLibre pede de novo via styleimagemissing.
  const handleLoad = useCallback((evt: any) => {
    const map = evt.target;
    ensureFireIcon(map);
    map.on('styleimagemissing', (e: { id: string }) => {
      if (e.id === FIRE_ICON_ID) ensureFireIcon(map);
    });
  }, []);

  const areaTiles = useMemo(() => [areaTilesUrl], [areaTilesUrl]);
  const ocorrenciaTiles = useMemo(() => [ocorrenciasTilesUrl], [ocorrenciasTilesUrl]);

  const handleClick = useCallback((evt: any) => {
    const features: any[] = evt.features || [];
    const areaFeature = features.find((f) => f.layer.id === 'areas-fill');
    const ocorrenciaFeature = features.find((f) => f.layer.id === 'ocorrencias-circle');
    const focoFeature = features.find((f) => f.layer.id === 'focos-icon');
    const lngLat = evt.lngLat;
    const point = { lng: lngLat.lng, lat: lngLat.lat };

    if (focoFeature && focoFeature.properties) {
      const foco = focoFeature.properties as FocoTileProperties;
      if (foco.n > 1) {
        // Grupo de focos: aproxima para separá-los.
        const [lng, lat] = focoFeature.geometry.coordinates as [number, number];
        evt.target.easeTo({ center: [lng, lat], zoom: Math.min(evt.target.getZoom() + 2, 14) });
      } else if (onSelectFoco) {
        onSelectFoco(foco);
      }
    } else if (ocorrenciaFeature && ocorrenciaFeature.properties && onSelectOcorrencia) {
      onSelectOcorrencia(ocorrenciaFeature.properties as OcorrenciaTileProperties, point);
    } else if (areaFeature && areaFeature.properties && onSelectArea) {
      onSelectArea(areaFeature.properties as AreaTileProperties, point);
    }
  }, [onSelectFoco, onSelectOcorrencia, onSelectArea]);

  const interactiveLayerIds = useMemo(() => [
    ...(layers.unidades ? ['areas-fill'] : []),
    ...(layers.ocorrencias ? ['ocorrencias-circle'] : []),
    ...(layers.focos ? ['focos-icon'] : []),
  ], [layers.unidades, layers.ocorrencias, layers.focos]);

  return (
    <div className="map-container">
      {error && <div className="map-overlay map-error-inline">Erro: {error}</div>}

      <Map
        initialViewState={INITIAL_VIEW}
        style={{ width: '100%', height: '100%' }}
        mapStyle={`https://api.maptiler.com/maps/hybrid/style.json?key=${MAPTILER_API_KEY}`}
        fadeDuration={0}
        maxTileCacheSize={1000}
        onClick={handleClick}
        onLoad={handleLoad}
        onError={(evt) => setError(String(evt.error?.message ?? evt.error) || 'Falha ao carregar o mapa. Verifique a chave do MapTiler.')}
        interactiveLayerIds={interactiveLayerIds}
      >
        <NavigationControl position="top-right" />

        {/* Protected area polygons (vector tiles) */}
        {layers.unidades && (
          <Source
            key={areaTilesUrl}
            id="areas"
            type="vector"
            tiles={areaTiles}
            minzoom={0}
            maxzoom={14}
          >
            <Layer
              id="areas-fill"
              type="fill"
              source-layer="uc"
              paint={{ 'fill-color': ucColorMatch as any, 'fill-opacity': 0.3 }}
            />
            <Layer
              id="areas-line"
              type="line"
              source-layer="uc"
              paint={{ 'line-color': ucColorMatch as any, 'line-width': 2 }}
            />
          </Source>
        )}

        {/* Occurrence markers (vector tiles) */}
        {layers.ocorrencias && (
          <Source
            key={ocorrenciasTilesUrl}
            id="ocorrencias"
            type="vector"
            tiles={ocorrenciaTiles}
            minzoom={0}
            maxzoom={14}
          >
            <Layer
              id="ocorrencias-circle"
              type="circle"
              source-layer="ocorrencia"
              paint={{
                'circle-color': occurrenceColorMatch as any,
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3, 8, 6, 14, 10] as any,
                'circle-stroke-color': '#fff',
                'circle-stroke-width': 1.5,
                'circle-opacity': 0.95,
              }}
            />
          </Source>
        )}

        {/* Focos de calor (INPE): ícone de fogo; nos zooms baixos cada ícone é um grupo */}
        {layers.focos && (
          <Source
            key={focosTilesUrl}
            id="focos"
            type="vector"
            tiles={focoTiles}
            minzoom={0}
            maxzoom={14}
          >
            <Layer
              id="focos-icon"
              type="symbol"
              source-layer="foco"
              layout={{
                'icon-image': FIRE_ICON_ID,
                // Grupo maior = ícone maior (escala logarítmica de n).
                'icon-size': ['interpolate', ['linear'], ['ln', ['get', 'n']], 0, 0.7, 4.6, 1, 9.2, 1.5] as any,
                'icon-anchor': 'bottom',
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'symbol-sort-key': ['get', 'n'] as any,
              }}
            />
          </Source>
        )}
      </Map>
    </div>
  );
}

export default memo(MapView);
