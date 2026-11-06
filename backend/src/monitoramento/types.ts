import type { MultiPolygon, Point, Polygon } from 'geojson';

export type MonitorGeometry = Point | Polygon | MultiPolygon;

export interface NormalizedMonitorEvent {
  idExterno: string;
  geometry: MonitorGeometry;
  tipoEventoCodigo: 'foco_calor' | 'alerta_deter';
  dataObservacao: string | null;
  precisaoData: 'instante' | 'dia' | 'desconhecida';
  biomaId: number | null;
  estadoUf: string | null;
  municipioNome: string | null;
  municipioCodigoIbge: string | null;
  satelite: string | null;
  riscoFogo: number | null;
  frpMw: number | null;
  classeFonte: string | null;
  propriedadesOrigem: Record<string, unknown>;
  historicoInicial: string;
}

export interface ReferenceMaps {
  biomas: Map<string, number>;
  estados: Map<string, string>;
}
