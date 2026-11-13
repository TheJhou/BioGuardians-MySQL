// Shared constants for BioGuardians frontend.
// Centralizes colors, labels, and configuration to avoid hardcoding.
//
// Cores de DADOS (categoria de ameaça, categoria de UC) vivem aqui e são a
// fonte única para mapa (MapLibre), badges e legendas — MapLibre precisa dos
// valores em JS. Cores da INTERFACE (paleta verde) vivem em styles/tokens.css;
// os gráficos as leem de lá via constants/chartTheme.ts.

// --- Threat category colors (IUCN/MMA standard) ---
export const CATEGORY_COLORS: Record<string, string> = {
  CR: '#d32f2f', // red — Critically Endangered
  EN: '#f57c00', // orange — Endangered
  VU: '#fbc02d', // yellow — Vulnerable
  NT: '#689f38', // light green — Near Threatened
  LC: '#388e3c', // green — Least Concern
  DD: '#757575', // gray — Data Deficient
  NE: '#90a4ae', // blue-gray — Not Evaluated / non-wildlife
};

// Texto sobre o fundo da categoria: escuro só onde o fundo é claro (VU amarelo).
const CATEGORY_TEXT_COLORS: Record<string, string> = {
  VU: '#333333',
};

// --- Threat category labels (Portuguese, public-friendly) ---
export const CATEGORY_LABELS: Record<string, string> = {
  CR: 'CR — Criticamente em Perigo',
  EN: 'EN — Entrando em Extinção',
  VU: 'VU — Alto Risco de Entrar em Extinção',
  NT: 'NT — Em Ameaça',
  LC: 'LC — Sem Risco',
  DD: 'DD — Sem Dados para Avaliar',
  NE: 'NE — Não Avaliada',
};

// --- UC category colors ---
export const UC_CATEGORY_COLORS: Record<string, string> = {
  protecao_integral: '#1565c0',  // blue
  uso_sustentavel: '#2e7d32',    // green
};

// --- Focos de calor (INPE) no mapa: cores do ícone de fogo ---
// Fonte única: o ícone desenhado em lib/fireIcon.ts e a legenda do mapa.
export const FOCO_CALOR_COLORS = {
  chama: '#ff6d00',    // laranja — corpo da chama
  miolo: '#ffd54f',    // amarelo — núcleo
  contorno: '#4e1600', // marrom escuro — contorno, legível sobre o satélite
};

// Janelas de tempo oferecidas no mapa (dias a partir do foco mais recente).
export const FOCO_DIAS_OPTIONS = [1, 3, 7, 30];

// --- UC category labels ---
export const UC_CATEGORY_LABELS: Record<string, string> = {
  protecao_integral: 'Proteção Integral',
  uso_sustentavel: 'Uso Sustentável',
};

// --- Sphere labels ---
export const SPHERE_LABELS: Record<string, string> = {
  federal: 'Federal',
  estadual: 'Estadual',
  municipal: 'Municipal',
  particular: 'Particular',
};

// --- Biome options for filter dropdowns ---
export const BIOME_OPTIONS = [
  { id: 1, nome: 'Amazonia' },
  { id: 2, nome: 'Mata Atlantica' },
  { id: 3, nome: 'Cerrado' },
  { id: 4, nome: 'Caatinga' },
  { id: 5, nome: 'Pampa' },
  { id: 6, nome: 'Pantanal' },
  { id: 7, nome: 'Marinho' },
];

// --- UC category options for map filter dropdowns ---
export const UC_CATEGORY_OPTIONS = [
  { codigo: 'protecao_integral', nome: 'Proteção Integral' },
  { codigo: 'uso_sustentavel', nome: 'Uso Sustentável' },
];

// --- Sphere options for map filter dropdowns ---
export const SPHERE_OPTIONS = [
  { value: 'federal', nome: 'Federal' },
  { value: 'estadual', nome: 'Estadual' },
  { value: 'municipal', nome: 'Municipal' },
  { value: 'particular', nome: 'Particular' },
];

// --- Category options for filter dropdowns ---
export const CATEGORY_OPTIONS = [
  { codigo: 'CR', nome: 'CR - Criticamente em Perigo' },
  { codigo: 'EN', nome: 'EN - Entrando em Extinção' },
  { codigo: 'VU', nome: 'VU - Alto Risco de Entrar em Extinção' },
  { codigo: 'NT', nome: 'NT - Em Ameaça' },
  { codigo: 'LC', nome: 'LC - Sem Risco' },
  { codigo: 'DD', nome: 'DD - Sem Dados para Avaliar' },
  { codigo: 'NE', nome: 'NE - Não Avaliada' },
];

// --- Status options ---
export const STATUS_OPTIONS = [
  { value: 'ativo', label: 'Active' },
  { value: 'inativo', label: 'Inactive' },
  { value: 'revisao', label: 'Under Review' },
];

// --- Map defaults ---
export const MAP_DEFAULTS = {
  center: { lat: -14, lng: -52 },
  zoom: 4,
};

// --- Helper: get color for a category, fallback to gray ---
export function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || '#757575';
}

// --- Helper: text color readable on top of the category color ---
export function getCategoryTextColor(category: string): string {
  return CATEGORY_TEXT_COLORS[category] || '#ffffff';
}

// --- Helper: get color for a UC category, fallback to blue ---
export function getUcCategoryColor(category: string): string {
  return UC_CATEGORY_COLORS[category] || '#1565c0';
}

// --- Brazilian states (UF) options ---
export const ESTADO_OPTIONS = [
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA',
  'MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN',
  'RS','RO','RR','SC','SP','SE','TO'
];

// --- Occurrence source labels ---
export const FONTE_LABELS: Record<string, string> = {
  gbif: 'GBIF',
  specieslink: 'speciesLink',
  camera_trap: 'Camera Trap',
  deteccao_ia: 'Deteccao por IA',
  deteccao_satelite: 'Deteccao por Satelite',
  carga_inicial: 'Carga Inicial',
  manual: 'Manual',
  icmbio: 'ICMBio',
};

export const FONTE_OPTIONS = Object.keys(FONTE_LABELS);
