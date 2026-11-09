# BioGuardians — Plano do Projeto

> Banco de Dados para Gestão de Biodiversidade e Espécies Ameaçadas

Sistema de banco de dados espacial em **MySQL 8.4** para gestão de espécies
ameaçadas, áreas protegidas e dados de monitoramento ambiental no Brasil, com
API Node.js e aplicação web React.

---

## 1. Contexto do Projeto

- **Disciplina**: Banco de Dados
- **Tema**: Gestão de biodiversidade e espécies ameaçadas (tema bio sustentável)
- **Foco**: Banco de dados (modelagem, persistência, consultas, integridade).
  A aplicação web é uma camada fina de demonstração.
- **Stack atual**: MySQL 8.4, Node.js 22 + Express 5, React 19, Vite, MapLibre, MapTiler Cloud, Chart.js e OpenTelemetry; ML service em Python (FastAPI) local
- **Recorte geográfico**: Brasil
- **Abordagem de dados**: Híbrida (carga inicial estática + consulta em tempo
  real ao GBIF)
- **Profundidade do BD**: triggers, stored procedure, tabelas agregadas,
  índices espaciais MySQL e constraints.

## 2. Problema que a Aplicação Resolve

### Problema central

A informação sobre espécies ameaçadas e áreas protegidas no Brasil está dispersa
em várias fontes (MMA, ICMBio, GBIF, speciesLink), em formatos diferentes (CSV,
shapefile, APIs), e não está integrada num só lugar que permita cruzar dados
geográficos com dados de espécies.

### Dores concretas

- **Fragmentação de dados** — para saber "quais espécies ameaçadas ocorrem
  dentro da UC X?", hoje é preciso baixar a lista do MMA, baixar o shapefile do
  CNUC, buscar ocorrências no GBIF, e cruzar tudo manualmente num GIS
  (QGIS/ArcGIS). Trabalhoso e técnico.
- **Falta de visão integrada num mapa** — as listas oficiais são tabelas em
  PDF/CSV, sem representação geográfica. Um gestor não consegue "ver" onde as
  espécies ameaçadas estão em relação às áreas protegidas.
- **Dificuldade de consulta espacial** — responder perguntas simples como "esta
  UC protege quantas espécies criticamente ameaçadas?" exige conhecimento
  técnico em GIS.
- **Dados desatualizados ou dispersos** — cada fonte atualiza num ritmo
  diferente; não há um ponto único de consulta consolidado.
- **Acesso restrito a especialistas** — as ferramentas atuais (QGIS, scripts em
  R/Python) são voltadas para pesquisadores; gestores públicos, ONGs e o público
  geral não conseguem usar facilmente.

### O que a aplicação faz para resolver

- Integra no banco MySQL espacial os dados de espécies ameaçadas +
  áreas protegidas + ocorrências
- Permite consultas espaciais nativas ("quais espécies dentro desta UC?",
  "esta ocorrência está dentro de uma área protegida?")
- Visualiza no mapa a relação entre espécies e áreas — algo que uma tabela não
  mostra
- Democratiza o acesso — uma interface web simples em vez de software GIS
  especializado

### Framing para apresentação

> "A aplicação resolve o problema da fragmentação e dificuldade de consulta dos
> dados de biodiversidade brasileiros. Hoje, cruzar espécies ameaçadas com áreas
> protegidas exige ferramentas técnicas de GIS e múltiplas fontes. Nosso sistema
> integra esses dados num banco espacial MySQL e oferece uma interface de
> mapa simples, permitindo que gestores, pesquisadores e o público respondam a
> perguntas como *quais espécies ameaçadas esta Unidade de Conservação protege?*
> em segundos."

## 3. Onde Pode Ser Aplicada (contextos reais)

- **Órgãos públicos de meio ambiente** — ICMBio, IBAMA, secretarias estaduais:
  gestores que monitoram UCs e espécies, priorizam ações de conservação e
  respondem a licenciamentos ambientais.
- **Licenciamento ambiental** — Empresas de consultoria ambiental e órgãos
  licenciadores avaliando impacto de obras sobre espécies ameaçadas e áreas
  protegidas.
- **ONGs e institutos de conservação** — SOS Mata Atlântica, WWF Brasil, IPÊ:
  entidades que direcionam recursos e campanhas com base num panorama
  geográfico.
- **Pesquisa acadêmica** — Estudos de distribuição de espécies, gap analysis,
  planejamento sistemático da conservação.
- **Educação e conscientização pública** — Escolas, museus, centros de ciência:
  uma interface de mapa é mais didática que uma lista em PDF.
- **Jornalismo de dados** — Reporters investigando conflitos entre espécies
  ameaçadas e atividades humanas.
- **Planejamento territorial** — Prefeituras e estados na elaboração de planos
  diretores e zoneamento ecológico-econômico.

## 4. Escopo

### Dentro do escopo

- Cadastro de espécies com taxonomia, categoria de ameaça (MMA/IUCN), bioma(s)
  e estado(s) de ocorrência
- Cadastro de áreas protegidas (UCs) com geometrias georreferenciadas SRID 4326
- Registro de ocorrências de espécies (ponto lat/long), vindas do GBIF em tempo
  real ou importadas
- Consultas espaciais: quais espécies ameaçadas ocorrem dentro de uma UC? qual
  UC protege a espécie X?
- Consultas analíticas para ranking de espécies por
  categoria, por bioma, por estado; UCs por categoria/esfera
- Integridade referencial e constraints (categoria válida, bioma válido,
  geometria válida)
- Triggers para auditoria (log de alterações) e validações automáticas
- Índices espaciais nativos do MySQL e índices convencionais para performance
- Interface web de demonstração: páginas principais de biodiversidade,
  dashboard, mapa, espécies e monitoramento
  - **Home**: apresentação do projeto, destaques e fontes
  - **Dashboard**: estatísticas agregadas em tabelas atualizadas pela procedure
  - **Mapa**: MapLibre + MapTiler Cloud com polígonos das UCs, filtros e legenda
  - **Espécies**: lista com scroll infinito (15 em 15) e detalhe com resumo da espécie
  - **Monitoramento**: focos de calor e alertas DETER com filtros e detalhes
- Responsivo: navegação mobile com bottom nav, layouts adaptáveis
- Enriquecimento de resumos: Wikipedia (PT/EN), Wikidata, iNaturalist e EOL
- Enriquecimento de imagens: iNaturalist, Wikimedia Commons (via Wikidata) e Wikipedia
- Classificação de fotos de camera trap por IA (OpenRouter + Claude), gerando
  ocorrências com `confianca_ia` — ML service local, fora da produção
- Observabilidade: traces, métricas e logs com OpenTelemetry + Grafana

### Fora do escopo

- Criação, edição ou remoção de dados pela interface/API (a API é somente leitura;
  a carga é feita por scripts)
- Autenticação de usuários / login
- Importação automática de shapefiles/CSVs via interface (via script SQL)
- Relatórios em PDF
- Notificações
- App mobile

## 5. Fluxo da Aplicação

```
┌─────────────────────────────────────────────────────────────┐
│                    FONTES DE DADOS                          │
│  MMA (CSV)  ICMBio (DwC-A)  CNUC (Shapefile)  GBIF (API)   │
└───────────┬─────────────────────────────────────────────────┘

        │ scripts Node em scripts/data (CSV, shapefile, APIs)
        ▼
┌─────────────────────────────────────────────────────────────┐
│                 MySQL 8.4 (núcleo do projeto)               │
│                                                             │
│  Tabelas: especie, area_protegida, ocorrencia,              │
│           ocorrencia_area, bioma, estado, categoria_ameaca, │
│           taxon, log_auditoria, area_tile (+ tabelas de ML) │
│  Tabelas agregadas: dashboard_stats, especies_por_uc,       │
│           ranking_especies_categoria, ucs_por_esfera        │
│  Triggers: auditoria, validação de geometria, sync          │
│           lat/lon↔geom, ocorrencia_area, cache              │
│  Índices: espaciais nativos, B-tree                         │
└───────────┬─────────────────────────────────────────────────┘

        │ SQL / queries parametrizadas
        ▼
┌─────────────────────────────────────────────────────────────┐
│              API Node.js (camada fina)                      │
│  Endpoints REST somente leitura (só GET)                    │
│  - GET /api/especies (filtros + busca)                      │
│  - GET /api/areas/tiles/:z/:x/:y.mvt  (tiles das UCs)       │
│  - GET /api/ocorrencias/tiles/:z/:x/:y.mvt                  │
│  - GET /api/areas/:id/especies  (consulta espacial)         │
│  - GET /api/especies/:id/areas-protegidas                   │
│  - GET /api/dashboard                                       │
└───────────┬─────────────────────────────────────────────────┘

        │ JSON / GeoJSON / MVT
        ▼
┌─────────────────────────────────────────────────────────────┐
│         React + MapTiler Cloud (interface de demo)          │
│  - Mapa com polígonos das UCs e ocorrências (tiles MVT)     │
│  - Filtros (esfera, categoria, bioma, espécie)              │
│  - Dashboard com gráficos (stats agregadas no MySQL)         │
│  - Lista e detalhe de espécies                              │
└─────────────────────────────────────────────────────────────┘
```

### Fluxo de uso típico

1. Usuário abre o mapa → MapLibre pede `GET /api/areas/tiles/{z}/{x}/{y}.mvt` →
   a API devolve o tile pré-gerado da tabela `area_tile` (ou monta GeoJSON e
   codifica o MVT no Node.js) → o mapa desenha os polígonos sobre o basemap MapTiler
2. Usuário filtra "espécies criticamente ameaçadas (CR)" →
   `GET /api/especies?categoria=CR` → API roda query com JOIN → retorna lista
3. Usuário escolhe uma espécie → tiles de ocorrências filtrados por espécie →
   pontos no mapa
4. Usuário clica numa UC → `GET /api/areas/5/info` e `GET /api/areas/5/especies`
   → `especies_em_area(5)` faz JOIN em `ocorrencia_area` (relação espacial já
   calculada por trigger) → lista espécies ameaçadas dentro da UC
5. Um script de carga (ex.: `load_mma_especies.mjs`) insere ou altera espécies →
   o trigger de auditoria registra a alteração na tabela `log_auditoria`. A
   interface web é só de consulta: não há cadastro pela API.

## 6. Modelo de Dados

> Esta seção foi o esboço inicial. O schema implementado (com colunas, tipos e
> tabelas adicionadas depois, como `ocorrencia_area`, `area_tile` e as tabelas
> do ML service) está em `DATA_DICTIONARY.md` e `ERD.md`.

### Tabelas principais

- `categoria_ameaca` (CR, EN, VU, NT, LC, DD, NE) — domínio fixo
- `bioma` (Amazônia, Mata Atlântica, Cerrado, Caatinga, Pampa, Pantanal, Marinho)
- `estado` (27 UF)
- `taxon` — hierarquia taxonômica (reino → filo → classe → ordem → família → gênero)
- `especie` (id, nome_cientifico, nome_popular, categoria_ameaca_id, descricao, status)
- `especie_bioma` (N:N espécie ↔ bioma)
- `especie_estado` (N:N espécie ↔ estado)
- `area_protegida` (id, nome, categoria_uc, esfera, bioma_id, area_ha, geom POLYGON/MULTIPOLYGON)
- `ocorrencia` (id, especie_id, lat, lon, geom POINT, data, fonte, base_registro)
- `log_auditoria` (id, tabela, operacao, registro_id, usuario, timestamp, dados_anteriores)

### Recursos de BD a destacar na avaliação

- **MySQL espacial**: colunas `GEOMETRY SRID 4326`, funções espaciais,
  GeoJSON e índices espaciais
- **Agregados de dashboard** em tabelas comuns, atualizadas por
  `CALL refresh_dashboard()`
- **Triggers** de auditoria (AFTER INSERT/UPDATE/DELETE)
- **Constraints**: CHECK em categoria, UNIQUE em nome_cientifico, FKs com
  ON DELETE RESTRICT/CASCADE
- **Enums ou domínios** para categoria_ameaca e esfera
- **Índices** em colunas de busca frequente (nome científico, categoria e
  geometria)

### Extensão: monitoramento ambiental

A modelagem foi implementada nas migrations `003_monitoramento_ambiental.sql` e
`004_activate_terrabrasilis_deter.sql`. Ela cria um domínio separado para focos
de calor do INPE e alertas públicos do DETER. O modelo, o mapeamento dos campos
e os limites atuais de atendimento estão em
[`ENVIRONMENTAL_MONITORING_MODEL.md`](ENVIRONMENTAL_MONITORING_MODEL.md).

- `monitor_fonte`, `monitor_tipo_evento` e `monitor_execucao` catalogam as
  fontes e rastreiam as coletas.
- `monitor_evento` guarda os dados de origem e a geometria SRID 4326, sem
  misturar alertas ambientais com observações de espécies.
- `monitor_prioridade` está reservada para o score do projeto e a versão da
  regra; o cálculo ainda não está implementado.
- `monitor_atendimento` guarda o status corrente (`novo`, `em_andamento`,
  `resolvido`) e `monitor_atendimento_historico` registra a entrada inicial
  criada durante a ingestão. A API atual não oferece transições de status.
- `monitor_evento_uc` relaciona eventos às UCs por contenção ou interseção
  espacial.

O backend importa o CSV diário de focos de calor do INPE e os WFS públicos DETER
Amazônia e Cerrado. O serviço `monitor-worker` agenda coletas segundo a
frequência do catálogo; o CLI permite cargas manuais e simulação com `--dry-run`.
A API e a página `/monitoramento` consultam eventos, resumo, fontes e execuções.
Todas as rotas permanecem somente GET; não há fluxo de alteração de status.
`monitor_prioridade` está no schema, mas o cálculo de prioridade ainda não foi
implementado.

## 7. Fontes de Dados

| Fonte | Formato | Conteúdo | Uso |
|-------|---------|----------|-----|
| MMA — dados.mma.gov.br | CSV | Lista oficial de espécies ameaçadas | Carga inicial |
| ICMBio — ipt.icmbio.gov.br | DwC-A | Avaliações de risco da fauna | Carga complementar |
| CNUC/MMA | Shapefile | Polígonos das UCs | Carga via `load_cnuc_ucs.mjs` (lib `shapefile`) |
| GBIF — api.gbif.org | API REST | Ocorrências georreferenciadas | Carga + proxy em tempo real (`/api/ocorrencias/gbif`) |
| speciesLink — specieslink.net | API REST (com chave) | Ocorrências de coleções brasileiras | Fonte complementar opcional |
| IUCN Red List (via GBIF) | API REST | Categoria global IUCN | Validação de categorias (`validate_categories.mjs`) |
| Wikipedia, Wikidata, iNaturalist, EOL, Wikimedia Commons | API REST | Resumos e imagens | Enriquecimento |
| Wildlife Insights | CSV + imagens | Fotos de camera trap | Entrada do ML service |
| INPE / Programa Queimadas | CSV diário | Focos de calor do Brasil | Importador MySQL `inpe_queimadas_diario_br` |
| TerraBrasilis / DETER Amazônia | WFS GeoJSON, EPSG:4674 → 4326 | Alertas poligonais públicos, com atraso aproximado de uma semana | Importador MySQL `terrabrasilis_deter_amazonia_wfs` |
| TerraBrasilis / DETER Cerrado | WFS GeoJSON, EPSG:4674 → 4326 | Alertas poligonais públicos, com atraso aproximado de uma semana | Importador MySQL `terrabrasilis_deter_cerrado_wfs` |

Os importadores ambientais acima e o `monitor-worker` já usam o backend MySQL.
Os demais scripts de `scripts/data/` e o ML service ainda precisam ser portados
do PostgreSQL antes de rodarem contra o banco atual.
