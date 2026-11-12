// BioGuardians TypeScript types for API responses.

export interface Bioma {
  id: number;
  nome: string;
  descricao: string | null;
}

export interface Estado {
  uf: string;
  nome: string;
  regiao: string;
}

export interface Categoria {
  codigo: string;
  nome: string;
  descricao: string | null;
  ordem_prioridade: number;
}

export interface Taxon {
  id: number;
  nome: string;
  rank: string;
  parent_id: number | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface Especie {
  id: number;
  nome_cientifico: string;
  nome_popular: string | null;
  categoria_ameaca: string;
  status: string;
  criado_em?: string;
  atualizado_em?: string;
  descricao?: string | null;
  imagem_url?: string | null;
  genero_id?: number;
  genero_nome?: string;
  confianca_ia?: number | null;
  biomas?: Bioma[];
  estados?: Estado[];
}

export interface EspecieBusca {
  especie_id: number;
  nome_cientifico: string;
  nome_popular: string | null;
  categoria: string;
  relevancia: number;
}

export interface AreaProtegida {
  id: number;
  nome: string;
  categoria_uc: string;
  esfera: string;
  bioma_id: number | null;
  area_ha: number | null;
  criado_em?: string;
  atualizado_em?: string;
}

export interface EspecieEmArea {
  especie_id: number;
  nome_cientifico: string;
  nome_popular: string | null;
  categoria: string;
}

export interface AreaProtegeEspecie {
  area_id: number;
  nome: string;
  categoria_uc: string;
  esfera: string;
}

export interface OcorrenciaProperties {
  id: number;
  especie_id: number;
  lat: number;
  lon: number;
  data_evento: string | null;
  fonte: string;
  base_registro: string | null;
  confianca_ia?: number | null;
  nome_cientifico: string;
  nome_popular: string | null;
  imagem_url: string | null;
  categoria_ameaca: string;
}

// Subset carregado nos tiles vetoriais — o resto vem de GET /ocorrencias/:id
export interface OcorrenciaTileProperties {
  id: number;
  especie_id: number;
  categoria_ameaca: string;
}

// Subset dos tiles de áreas — o resto vem de GET /areas/:id/info
export interface AreaTileProperties {
  id: number;
  categoria_uc: string;
}

export interface AreaInfo {
  id: number;
  nome: string;
  categoria_uc: string;
  esfera: string;
  bioma_id: number | null;
  bioma: string | null;
  area_ha: number | null;
}

export interface DashboardStats {
  id: number;
  total_especies: number;
  total_cr: number;
  total_en: number;
  total_vu: number;
  total_nt: number;
  total_lc: number;
  total_dd: number;
  total_areas: number;
  area_total_ha: number | null;
  total_ocorrencias: number;
}

export interface RankingCategoria {
  categoria_ameaca: string;
  total: number;
}

export interface UcsPorEsfera {
  esfera: string;
  total: number;
  area_ha: number | null;
}

export interface EspeciePresenteUc {
  especie_id: number;
  nome_cientifico: string;
  nome_popular: string | null;
  imagem_url: string | null;
  total_ucs: number;
}

export interface BiomaCount {
  nome: string;
  total: number;
}

export interface OcorrenciaPorAno {
  ano: number;
  total: number;
}

export interface UcPorCategoria {
  categoria_uc: string;
  total: number;
}

export interface EspecieMaisOcorrencias {
  especie_id: number;
  nome_cientifico: string;
  nome_popular: string | null;
  total: number;
}

export interface DashboardData {
  stats: DashboardStats;
  ranking: RankingCategoria[];
  ucs_por_esfera: UcsPorEsfera[];
  especies_mais_presentes_uc: EspeciePresenteUc[];
  especies_por_bioma: BiomaCount[];
  ocorrencias_por_ano: OcorrenciaPorAno[];
  ucs_por_categoria: UcPorCategoria[];
  especies_mais_ocorrencias: EspecieMaisOcorrencias[];
}

export type MonitorStatus = 'novo' | 'em_andamento' | 'resolvido';

export interface MonitorEventProperties {
  tipo: string;
  fonte: string;
  fonte_nome: string;
  data_observacao: string | null;
  precisao_data: 'instante' | 'dia' | 'desconhecida';
  bioma: string | null;
  estado_uf: string | null;
  municipio: string | null;
  satelite: string | null;
  risco_fogo: number | null;
  frp_mw: number | null;
  classe_fonte: string | null;
  area_alerta_ha: number | null;
  prioridade: 'baixa' | 'media' | 'alta' | 'critica' | null;
  score_prioridade: number | null;
  status_atendimento: MonitorStatus | null;
  municipio_codigo_ibge?: string | null;
  id_externo?: string;
  primeira_importacao_em?: string;
  ultima_vista_em?: string;
  atualizado_em?: string;
}

export interface MonitorEventFeature {
  type: 'Feature';
  id: number;
  geometry: { type: string; coordinates: unknown } | null;
  properties: MonitorEventProperties;
}

export interface MonitorEventCollection {
  type: 'FeatureCollection';
  features: MonitorEventFeature[];
  total: number;
  /** true quando há mais eventos do que a API conta (a API para em 10.000). */
  total_limitado?: boolean;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface MonitorEventDetail extends MonitorEventFeature {
  atendimento: {
    status: MonitorStatus | null;
    responsavel: string | null;
    criado_em: string | null;
    iniciado_em: string | null;
    resolvido_em: string | null;
  };
  prioridade: {
    versao_algoritmo: string;
    score_risco: number | null;
    score_recencia: number | null;
    score_sensibilidade: number | null;
    score_final: number;
    nivel: 'baixa' | 'media' | 'alta' | 'critica';
  } | null;
  historico_atendimento: Array<{
    status_anterior: MonitorStatus | null;
    status_novo: MonitorStatus;
    alterado_em: string;
    ator: string;
    observacao: string | null;
  }>;
  unidades_conservacao: Array<{
    id: number;
    nome: string;
    categoria_uc: string;
    esfera: string;
    tipo_relacao: 'contem_ponto' | 'intersecta_poligono';
    intersecao_ha: number | null;
  }>;
}

export interface MonitorSummary {
  total: number;
  por_tipo: Record<string, number>;
  por_status: Record<string, number>;
  por_prioridade: Record<string, number>;
  por_bioma: Record<string, number>;
  /** Quando os agregados sem filtro foram recalculados (fim da última importação). */
  atualizado_em?: string | null;
}

export interface MonitorSource {
  id: number;
  codigo: string;
  nome: string;
  orgao: string;
  produto: string;
  formato: 'csv' | 'wfs';
  frequencia_minutos: number | null;
  ativo: boolean | number;
  ultima_execucao_id: number | null;
  ultimo_status: string | null;
  ultima_execucao_em: string | null;
  concluida_em: string | null;
  registros_lidos: number | null;
  registros_novos: number | null;
  registros_atualizados: number | null;
  registros_rejeitados: number | null;
  ultimo_erro: string | null;
}

// GeoJSON types
export interface GeoJSONPoint {
  type: 'Point';
  coordinates: [number, number];
}

export interface GeoJSONPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

export interface GeoJSONFeature<P = Record<string, unknown>> {
  type: 'Feature';
  id?: number;
  geometry: GeoJSONPoint | GeoJSONPolygon;
  properties: P;
}

export interface GeoJSONFeatureCollection<P = Record<string, unknown>> {
  type: 'FeatureCollection';
  features: GeoJSONFeature<P>[];
}
