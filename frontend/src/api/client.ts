import type {
  Bioma, Estado, Categoria, Taxon, Especie, EspecieBusca,
  GeoJSONFeatureCollection, OcorrenciaProperties, DashboardData,
  EspecieEmArea, AreaProtegeEspecie, PaginatedResponse, AreaInfo,
  MonitorEventCollection, MonitorEventDetail, MonitorSummary, MonitorSource,
} from '../types/index.js';

// VITE_API_URL may be relative (`/api`, the production default). The MapLibre
// tile worker only accepts absolute URLs, so resolve it against the page origin.
export const API_URL = new URL(
  import.meta.env.VITE_API_URL || 'http://localhost:3001/api',
  window.location.origin,
).href.replace(/\/+$/, '');

const pendingRequests = new Map<string, Promise<unknown>>();

function fetchDeduplicated<T>(path: string): Promise<T> {
  const pending = pendingRequests.get(path) as Promise<T> | undefined;
  if (pending) return pending;
  const request = fetchApi<T>(path).finally(() => pendingRequests.delete(path));
  pendingRequests.set(path, request);
  return request;
}

// A API é somente leitura: todas as chamadas são GET simples (sem headers
// customizados, então o navegador não dispara preflight CORS).
async function fetchApi<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function buildQs(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  return qs.toString();
}

// --- Reference data ---
export const api = {
  // Biomas
  async getBiomas(): Promise<Bioma[]> {
    return fetchApi<Bioma[]>('/biomas');
  },

  // Estados
  async getEstados(): Promise<Estado[]> {
    return fetchApi<Estado[]>('/estados');
  },

  // Categorias
  async getCategorias(): Promise<Categoria[]> {
    return fetchApi<Categoria[]>('/categorias');
  },

  // Taxonomia
  async getTaxonomia(rank?: string): Promise<Taxon[]> {
    const path = rank ? `/taxonomia?rank=${encodeURIComponent(rank)}` : '/taxonomia';
    return fetchApi<Taxon[]>(path);
  },

  // Especies
  async getEspecies(params?: {
    categoria?: string; bioma?: number; estado?: string; status?: string; busca?: string;
    page?: number; per_page?: number;
  }): Promise<PaginatedResponse<Especie | EspecieBusca>> {
    const qs = new URLSearchParams();
    if (params?.categoria) qs.set('categoria', params.categoria);
    if (params?.bioma) qs.set('bioma', String(params.bioma));
    if (params?.estado) qs.set('estado', params.estado);
    if (params?.status) qs.set('status', params.status);
    if (params?.busca) qs.set('busca', params.busca);
    if (params?.page) qs.set('page', String(params.page));
    if (params?.per_page) qs.set('per_page', String(params.per_page));
    const query = qs.toString();
    return fetchApi<PaginatedResponse<Especie | EspecieBusca>>(`/especies${query ? `?${query}` : ''}`);
  },

  async getEspecie(id: number): Promise<Especie> {
    return fetchApi<Especie>(`/especies/${id}`);
  },

  async getEspecieOcorrencias(id: number, params?: { page?: number; per_page?: number }): Promise<PaginatedResponse<OcorrenciaProperties>> {
    const qs = new URLSearchParams();
    if (params?.page) qs.set('page', String(params.page));
    if (params?.per_page) qs.set('per_page', String(params.per_page));
    const query = qs.toString();
    return fetchApi<PaginatedResponse<OcorrenciaProperties>>(`/especies/${id}/ocorrencias${query ? `?${query}` : ''}`);
  },

  async getAreasProtegemEspecie(id: number): Promise<AreaProtegeEspecie[]> {
    return fetchApi<AreaProtegeEspecie[]>(`/especies/${id}/areas-protegidas`);
  },

  // Areas
  async getAreas(params?: {
    bioma?: number; esfera?: string; categoria?: string; busca?: string;
    bbox?: string; zoom?: number;
  }): Promise<GeoJSONFeatureCollection> {
    const qs = new URLSearchParams();
    if (params?.bioma) qs.set('bioma', String(params.bioma));
    if (params?.esfera) qs.set('esfera', params.esfera);
    if (params?.categoria) qs.set('categoria', params.categoria);
    if (params?.busca) qs.set('busca', params.busca);
    if (params?.bbox) qs.set('bbox', params.bbox);
    if (params?.zoom) qs.set('zoom', String(params.zoom));
    const query = qs.toString();
    const path = `/areas${query ? `?${query}` : ''}`;
    return fetchDeduplicated<GeoJSONFeatureCollection>(path);
  },

  getAreaTilesUrl(params?: { esfera?: string; categoria?: string; bioma?: number }): string {
    const query = buildQs({
      esfera: params?.esfera,
      categoria: params?.categoria,
      bioma: params?.bioma,
    });
    return `${API_URL}/areas/tiles/{z}/{x}/{y}.mvt${query ? `?${query}` : ''}`;
  },

  async getArea(id: number): Promise<GeoJSONFeatureCollection> {
    return fetchApi<GeoJSONFeatureCollection>(`/areas/${id}`);
  },

  async getAreaInfo(id: number): Promise<AreaInfo> {
    return fetchApi<AreaInfo>(`/areas/${id}/info`);
  },

  async getEspeciesEmArea(id: number): Promise<EspecieEmArea[]> {
    return fetchApi<EspecieEmArea[]>(`/areas/${id}/especies`);
  },

  // Ocorrencias
  async getOcorrencias(params?: {
    especie_id?: number | number[]; categoria?: string; bioma?: number; fonte?: string; limit?: number; bbox?: string;
  }): Promise<GeoJSONFeatureCollection<OcorrenciaProperties>> {
    const qs = new URLSearchParams();
    if (params?.especie_id) {
      const ids = Array.isArray(params.especie_id) ? params.especie_id.join(',') : String(params.especie_id);
      if (ids) qs.set('especie_id', ids);
    }
    if (params?.categoria) qs.set('categoria', params.categoria);
    if (params?.bioma) qs.set('bioma', String(params.bioma));
    if (params?.fonte) qs.set('fonte', params.fonte);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.bbox) qs.set('bbox', params.bbox);
    const query = qs.toString();
    const path = `/ocorrencias${query ? `?${query}` : ''}`;
    return fetchDeduplicated<GeoJSONFeatureCollection<OcorrenciaProperties>>(path);
  },

  getOcorrenciasTilesUrl(params?: { especie_id?: number[]; categoria?: string; fonte?: string; bioma?: number }): string {
    const query = buildQs({
      especie_id: params?.especie_id?.join(','),
      categoria: params?.categoria,
      fonte: params?.fonte,
      bioma: params?.bioma,
    });
    return `${API_URL}/ocorrencias/tiles/{z}/{x}/{y}.mvt${query ? `?${query}` : ''}`;
  },

  async getOcorrencia(id: number): Promise<OcorrenciaProperties> {
    return fetchApi<OcorrenciaProperties>(`/ocorrencias/${id}`);
  },

  async getGbifOcorrencias(especie: string): Promise<GeoJSONFeatureCollection> {
    return fetchApi<GeoJSONFeatureCollection>(
      `/ocorrencias/gbif?especie=${encodeURIComponent(especie)}`
    );
  },

  // Dashboard
  async getDashboard(): Promise<DashboardData> {
    return fetchApi<DashboardData>('/dashboard');
  },

  // Monitoramento ambiental — consultas somente GET.
  async getMonitoramentoEventos(params?: {
    tipo?: string; fonte?: string; bioma_id?: number; estado_uf?: string;
    desde?: string; ate?: string; status?: string; prioridade?: string;
    bbox?: string; page?: number; per_page?: number;
  }): Promise<MonitorEventCollection> {
    const query = buildQs(params ?? {});
    return fetchDeduplicated<MonitorEventCollection>(`/monitoramento/eventos${query ? `?${query}` : ''}`);
  },

  async getMonitoramentoEvento(id: number): Promise<MonitorEventDetail> {
    return fetchApi<MonitorEventDetail>(`/monitoramento/eventos/${id}`);
  },

  async getMonitoramentoResumo(params?: { desde?: string; ate?: string }): Promise<MonitorSummary> {
    const query = buildQs(params ?? {});
    return fetchApi<MonitorSummary>(`/monitoramento/resumo${query ? `?${query}` : ''}`);
  },

  async getMonitoramentoFontes(): Promise<{ data: MonitorSource[] }> {
    return fetchApi<{ data: MonitorSource[] }>('/monitoramento/fontes');
  },
};
