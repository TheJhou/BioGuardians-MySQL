# BioGuardians

Sistema de banco de dados espacial (MySQL 8.4, com tipos espaciais nativos)
para gestão de **espécies ameaçadas** e **áreas protegidas** no Brasil, com
aplicação web (Node.js + React + MapTiler Cloud) como camada fina de demonstração.

> Projeto da disciplina de **Banco de Dados** — foco em modelagem, persistência,
> consultas espaciais, integridade e recursos avançados de BD.

## Estrutura

```
BioGuardians/
├── docker-compose.yml                # dev: db, migrate, backend, frontend, ml-service (GPU)
├── docker-compose.observability.yml  # overlay: otel-collector, prometheus, tempo, loki, grafana
├── docker-compose.prod.yml           # imagens do GHCR: backend + frontend (sem ML, sem observabilidade)
├── stack.yml                         # produção (VM): backend, frontend + observabilidade
├── otel-collector-config.yaml        # configuração do OTel Collector
├── .env.example                      # variáveis de ambiente (copiar para .env)
├── .github/workflows/
│   ├── ci.yml                        # PRs/branches: migrations em banco efêmero + typecheck
│   └── deploy.yml                    # main: build GHCR, migrations, deploy na VM
├── db/
│   ├── migrate.sh                    # migration runner
│   ├── migrations/                   # 001–003 (SQL numerados)
│   └── tests/smoke_test.sql
├── backend/                          # Node 22 + Express 5 + TypeScript
│   └── scripts/generateAreaTiles.ts  # pré-geração dos tiles das UCs
├── frontend/                         # React 19 + Vite + MapLibre + Chart.js
├── ml-service/                       # Python + FastAPI (classificação de camera trap via OpenRouter)
├── scripts/data/                     # importadores (MMA, CNUC, GBIF, speciesLink) e enriquecimento
├── observability/                    # Grafana, Prometheus, Tempo, Loki
├── infra/nginx/bioguardians.conf     # Nginx da VM (TLS + subdomínios)
└── docs/
    ├── PROJECT_PLAN.md
    ├── DATA_DICTIONARY.md
    ├── ERD.md
    ├── ENVIRONMENTAL_MONITORING_MODEL.md
    ├── OBSERVABILITY.md
    └── AREA_TILE_CACHE.md
```

## Como subir tudo (Docker Compose)

```bash
cp .env.example .env
# edite .env: credenciais do banco e VITE_MAPTILER_API_KEY (obrigatória)

docker compose up -d db            # PostgreSQL + PostGIS
docker compose run --rm migrate    # aplica as migrations
docker compose up -d backend       # API (porta 3001, tsx watch com hot reload)
docker compose up -d frontend      # build de produção servido por Nginx (porta 5173)
```

Acesse:
- Frontend: http://localhost:5173
- API: http://localhost:3001/api/health
- Banco: localhost:5432
- Grafana (com o overlay de observabilidade): http://localhost:3000

> O container do frontend faz o build do Vite e serve os arquivos estáticos;
> para hot reload rode `npm install && npm run dev` dentro de `frontend/`.

Para subir a observabilidade junto:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

Detalhes em `docs/OBSERVABILITY.md`.

## Como subir o banco

### Opção A — Docker Compose (dev)

```bash
cp .env.example .env
docker compose up -d db
docker compose run --rm migrate
```

### Opção B — Instalação nativa (Oracle Cloud VM / Linux)

Em Oracle Linux, use `dnf` (não `apt`):

```bash
sudo dnf install -y postgresql-server postgresql-contrib postgis
sudo postgresql-setup initdb
sudo systemctl enable --now postgresql
sudo -u postgres createuser bioguard --superuser
sudo -u postgres psql -c "ALTER USER bioguard WITH PASSWORD 'sua_senha';"
sudo -u postgres createdb bioguardians -O bioguard
sh db/migrate.sh
```

Configure `pg_hba.conf` e `postgresql.conf` para conexões locais e da rede Docker. Veja a seção de deploy para detalhes.

## Carga de dados reais

Os scripts em `scripts/data/` importam dados oficiais no banco
(detalhes em `scripts/data/README.md`):

```bash
cd scripts/data
npm install

npm run load:mma             # espécies ameaçadas (MMA, CSV)
npm run load:cnuc            # Unidades de Conservação (CNUC, shapefile em input/cnuc_ucs/)
npm run load:gbif            # ocorrências via GBIF
npm run load:splink          # ocorrências via speciesLink (requer SPLINK_API_KEY)
npm run enrich:descriptions  # resumos: Wikipedia, Wikidata, iNaturalist, EOL
npm run enrich:images        # imagens: iNaturalist, Wikimedia Commons, Wikipedia
node validate_categories.mjs # padroniza categorias de ameaça (MMA > IUCN > IA)
```

> Os scripts requerem Node.js 22+ e leem as credenciais do `.env` da raiz.

Os loaders de UCs e ocorrências já chamam `refresh_dashboard()` no final. Depois
de carregar UCs, regenere os tiles do mapa:

```bash
cd backend && npm run generate-area-tiles
```

## ML Service — Classificação de Camera Trap com IA

O `ml-service/` é um microserviço Python (FastAPI) que classifica fotos de
camera trap usando **OpenRouter + Claude Sonnet 4** (API externa, paga por token)
e grava espécies, detecções e ocorrências direto no banco.

> **Roda localmente** na máquina com GPU — **não é deployado na VM de produção**.
> O backend só expõe os jobs via proxy somente leitura (`/api/deteccoes`), que
> responde erro quando o ML service não está rodando.

### Jornada técnica

1. **Satélite (CBERS-4A)** — descartado: resolução ~2m/pixel insuficiente para fauna
2. **YOLO (detecção + crop)** — descartado: falsos positivos e crops ruins
3. **VLM local (Qwen2-VL-2B + QLoRA)** — descartado pra produção: melhor versão
   atingiu ~62-70% de acurácia, insuficiente
4. **IA externa via API (atual)** — OpenRouter, ~100% de aproveitamento nas
   imagens que a IA realmente processou; custo por imagem (créditos)

### Pipeline

```
Wildlife Insights CSV → download autenticado (GraphQL) → cache local
    → OpenRouter/Claude classifica a imagem completa (VLM_CONCURRENCY em paralelo, default 8)
    → dedup: mesmo image_id, hash SHA-256 ou deployment+timestamp → pula
    → se confiança >= 0.3: salva espécie + ocorrência no banco
    → se confiança < 0.3 ou sem espécie: salva como rejeitada
```

### Como usar (local com GPU)

```bash
# 1. Subir o banco
docker compose up -d db
docker compose run --rm migrate

# 2. Buildar a imagem do ML service
docker build -t bioguardians-ml ./ml-service

# 3. Processar imagens do Wildlife Insights (classifica via OpenRouter)
docker run --rm --gpus all \
  -e DATABASE_URL=postgresql://user:pass@host.docker.internal:5432/bioguardians \
  -e WI_EMAIL=your_email -e WI_PASSWORD=your_password \
  -e OPENROUTER_API_KEY=your_key \
  -e LOCAL_VLM_ENABLED=false \
  -v /path/to/wildlife-insights-data:/data/wi:ro \
  -v bioguardians_ml_images:/app/images \
  bioguardians-ml python -m app.cli ingest --source camera_trap --data-dir /data/wi --limit 50

# 4. Preparar dataset para fine-tune (baixa ~9.680 imagens) — experimentos
docker run --rm --gpus all \
  -e WI_EMAIL=your_email -e WI_PASSWORD=your_password \
  -v /path/to/wildlife-insights-data:/data/wi:ro \
  -v /path/to/output:/data/dataset \
  bioguardians-ml python -m app.cli prepare-dataset --data-dir /data/wi --output-dir /data/dataset

# 5. Fine-tunar Qwen2-VL-2B com QLoRA (~2-4h na RTX 4060) — experimentos
docker run --rm --gpus all \
  -v /path/to/dataset:/data/dataset \
  -v /path/to/models:/models \
  bioguardians-ml python -m app.cli finetune --dataset-dir /data/dataset --output-dir /models/qwen2vl-finetuned
```

Com o `docker-compose.yml`, o serviço `ml-service` sobe com a API em
`127.0.0.1:8001` e monta `./dados` em `/data` (somente leitura).

### Env vars do ML service

| Variável | Descrição | Default |
|----------|-----------|---------|
| `DATABASE_URL` | String de conexão PostgreSQL | (obrigatório) |
| `OPENROUTER_API_KEY` | Chave OpenRouter (classificador principal) | vazio |
| `OPENROUTER_MODEL` | Modelo | `anthropic/claude-sonnet-4` |
| `LOCAL_VLM_ENABLED` | `false` = só OpenRouter (recomendado) | `true` |
| `LOCAL_VLM_PATH` | Caminho do modelo local fine-tuned | `models/qwen2vl-finetuned` (compose) |
| `WI_CACHE_ONLY` | `true` = não baixa, só processa cache | `false` |
| `YOLO_DEVICE` | Device do VLM local (`cuda` ou `cpu`) | `cuda` |
| `WI_EMAIL` / `WI_PASSWORD` | Credenciais Wildlife Insights | vazio |
| `SPECIES_CONFIDENCE_THRESHOLD` | Threshold de aceitação | `0.3` |
| `VLM_CONCURRENCY` | Chamadas OpenRouter em paralelo | `8` |
| `HTTP_TIMEOUT` | Timeout das chamadas OpenRouter (s) | `120` |
| `DB_POOL_MAX` | Tamanho do pool de conexões | `20` |
| `IMAGE_STORAGE_DIR` | Cache de imagens | `/app/images` |

## Sistema de Migrations

O projeto usa um sistema de migrations customizado (`db/migrate.sh`) que:

- Aplica os arquivos SQL de `db/migrations/` em ordem alfabética
- Registra as migrations aplicadas na tabela `schema_migrations`
- Calcula o hash **SHA-256** de cada arquivo e **aborta** se um arquivo já aplicado foi alterado
- Roda cada migration numa **transação** junto com o registro no journal — se falhar, é revertida.
  Exceção: arquivos que começam com `-- @no-transaction` (a `001`, que usa `ALTER TYPE ... ADD VALUE`)
- É **idempotente** — rodar de novo pula o que já foi aplicado

```bash
sh db/migrate.sh             # aplica migrations pendentes
sh db/migrate.sh --status    # mostra status (APPLIED / PENDING / TAMPERED)
sh db/migrate.sh --dry-run   # simula
```

| Migration | Conteúdo |
|-----------|----------|
| `001_initial.sql` | Schema consolidado: extensões, enums, domínios, tabelas, índices, funções, triggers, views materializadas, dados de referência e parâmetros de performance |
| `002_schema_hardening.sql` | `registro_id` BIGINT na auditoria, `deteccao.geom` + GIST, sync bidirecional lat/lon ↔ geom, `dashboard_stats` com scan único |
| `003_ocorrencia_area.sql` | Junção `ocorrencia_area` mantida por trigger; funções e `especies_por_uc` sem `ST_Contains` na leitura |
| `004_area_tile_cache.sql` | Tabela `area_tile` com os tiles MVT das UCs (ver `docs/AREA_TILE_CACHE.md`) |
| `005_audit_without_geometry.sql` | Auditoria guarda `geom_md5` em vez do polígono inteiro |

## Otimizações de BD

### Relação espacial pré-calculada
- `ocorrencia_area` guarda em quais UCs cada ocorrência cai (N:N, UCs podem se sobrepor)
- Triggers recalculam a relação quando uma ocorrência ou a geometria de uma área muda
- `especies_em_area`, `areas_protegem_especie`, `contar_ocorrencias_em_area` e `especies_por_uc`
  viram JOIN de inteiros — o `ST_Contains` roda uma vez por escrita, não a cada leitura

### Tiles vetoriais
- Áreas e ocorrências são servidas como tiles MVT (`ST_AsMVT`)
- Tiles de UCs sem filtro ficam persistidos em `area_tile` (~10–20 ms por tile); ver `docs/AREA_TILE_CACHE.md`

### Parâmetros do banco
A `001` aplica via `ALTER DATABASE ... SET` (só quando o valor atual difere):
- `max_parallel_workers_per_gather = 2`, `parallel_setup_cost = 100`, `parallel_tuple_cost = 0.03`
- `effective_cache_size = 1GB`, `work_mem = 8MB`, `maintenance_work_mem = 128MB`
- `random_page_cost = 1.1` (SSD)

No `docker-compose.yml` (dev), o container do Postgres sobe com `shared_buffers=2GB`,
`effective_cache_size=4GB`, `work_mem=64MB`, `maintenance_work_mem=512MB` e `shm_size: 4gb`.

### Busca
- A API (`GET /api/especies?busca=`) usa `unaccent(lower(...)) LIKE`, insensível a acento e caixa
- No SQL também há full-text search: coluna gerada `tsv_busca` (nome científico + popular + descrição,
  config `portuguese`) com índice GIN e a função `buscar_especies('onca')` ordenada por `ts_rank`

### Índices compostos e parciais
- `idx_ocorrencia_especie_data(especie_id, data_evento DESC)`
- `idx_especie_cat_status(categoria_ameaca, status)`
- Parciais em `deteccao`, `imagem_job` e `especie` (ex.: espécies sem imagem)

### Cache (LRU in-memory)
- Backend usa `lru-cache` nos endpoints de leitura pesada
- TTL por rota: dashboard e referências 60s, áreas e ocorrências 30s, detecções 10s, GBIF 5min, tiles 1h
- Como a API é somente leitura, o cache só expira por TTL; dados carregados pelos
  scripts aparecem no máximo após o TTL da rota (ou reiniciando o backend)
- Trigger no BD atualiza `cache_metadata` a cada escrita em espécie/área/ocorrência

## CI/CD

### CI (`.github/workflows/ci.yml`)
Roda em PRs para a `main` e em push para qualquer outra branch:
1. Sobe um PostGIS efêmero, aplica as migrations, roda o smoke test e aplica de novo (checa idempotência)
2. `tsc --noEmit` no backend
3. `tsc --noEmit` no frontend

### Deploy (`.github/workflows/deploy.yml`)
Roda a cada `push` na `main` (commits que só mudam `*.md` não disparam):

1. **prepare** — detecta quais serviços mudaram e valida a numeração sequencial das migrations
2. **build** — builda e publica no GHCR as imagens que mudaram; as outras só recebem a nova tag
3. **migrate** — aplica migrations e roda o smoke test no PostgreSQL de produção
4. **generate-stack** — renderiza `stack.yml` com os secrets
5. **deploy** — envia `stack.yml`, `observability/` e `otel-collector-config.yaml` para a VM e sobe os containers

```
main
  │
  v
GitHub Actions
  +-- prepare (diff de caminhos, validação das migrations)
  +-- build (frontend + backend → GHCR)
  +-- migrate (migrate.sh + smoke test no banco de produção)
  +-- generate-stack (renderiza stack.yml)
  +-- deploy (SSH/SCP + docker compose na VM)
  v
VM Oracle Linux
  +-- Nginx (80/443) → frontend (:8080) / backend (:3001) / Grafana (:3000)
  +-- Containers: backend, frontend, otel-collector, prometheus, tempo, loki, grafana
  +-- PostgreSQL nativo
```

### Secrets necessários no GitHub

| Secret | Uso |
|--------|-----|
| `DB_USER` | Usuário do PostgreSQL de produção |
| `DB_PASSWORD` | Senha do PostgreSQL de produção |
| `DB_NAME` | Nome do banco de produção |
| `DB_HOST` | Host do banco (acessível pelo runner e pelos containers da VM) |
| `DB_PORT` | Porta do PostgreSQL (default 5432) |
| `FRONTEND_URL` | Origem permitida no CORS (default `https://financemobile.com.br`) |
| `VITE_API_URL` | URL da API no build do frontend (default `https://api.financemobile.com.br/api`) |
| `VITE_MAPTILER_API_KEY` | Chave da API do MapTiler Cloud |
| `GRAFANA_ADMIN_PASSWORD` | Senha do admin do Grafana |
| `ORACLE_SSH_HOST` | IP público da VM |
| `ORACLE_SSH_USER` | Usuário SSH (ex: `opc`) |
| `ORACLE_SSH_KEY` | Chave privada SSH (PEM) |
| `ORACLE_SSH_PORT` | Porta SSH (opcional, default 22) |

> `GITHUB_TOKEN` é automático e precisa de permissão `packages: write` para publicar no GHCR.

### Configuração na VM

Requisitos na VM (Oracle Linux):

```bash
sudo dnf install -y docker-ce nginx git
sudo systemctl enable --now docker
```

O PostgreSQL roda **nativamente** na VM. Ajuste `pg_hba.conf` e `postgresql.conf` para aceitar conexões de `127.0.0.1` e da rede Docker.

O workflow cria `~/bioguardians/` e envia automaticamente `stack.yml`, `observability/` e `otel-collector-config.yaml`.

### Domínio e Nginx

Produção usa **Nginx na VM** como proxy reverso com certificado Cloudflare Origin CA
(config em `infra/nginx/bioguardians.conf`):

```
Internet → Cloudflare → Nginx (VM) :80 → redirect HTTPS / :443
  financemobile.com.br          → 127.0.0.1:8080 (frontend)
  api.financemobile.com.br      → 127.0.0.1:3001 (backend)
  grafana.financemobile.com.br  → 127.0.0.1:3000 (Grafana)
  pgadmin / portainer           → serviços rodando direto na VM
```

Não commite certificados nem chaves no repositório. Passo a passo no `AGENTS.md`.

### Deploy manual (emergência)

```bash
cd ~/bioguardians
sudo docker compose -f stack.yml pull
sudo docker compose -f stack.yml up -d

sudo docker compose -f stack.yml ps
sudo docker compose -f stack.yml logs backend --tail 50
```

## API Endpoints

A API é **somente leitura**: só existem rotas `GET` (o CORS também aceita só GET).
Dados entram no banco pelos scripts de `scripts/data/`, pelas migrations e pelo
ML service local — nunca pela API pública.

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/api/health` | Health check |
| GET | `/api/biomas` | Lista biomas |
| GET | `/api/estados` | Lista estados |
| GET | `/api/categorias` | Lista categorias de ameaça |
| GET | `/api/taxonomia?rank=genero` | Lista taxonomia |
| GET | `/api/especies?categoria=CR&bioma=1&estado=SP&busca=onca&page=1&per_page=20` | Lista espécies (filtros + busca sem acento, paginada) |
| GET | `/api/especies/:id` | Detalhe da espécie (com biomas e estados) |
| GET | `/api/especies/:id/ocorrencias` | Ocorrências da espécie (paginada) |
| GET | `/api/especies/:id/areas-protegidas` | UCs onde a espécie ocorre |
| GET | `/api/areas?bioma=&esfera=&categoria=&busca=&bbox=&zoom=` | Áreas como GeoJSON FeatureCollection |
| GET | `/api/areas/tiles/:z/:x/:y.mvt` | Tile vetorial das UCs (filtros opcionais: `esfera`, `categoria`, `bioma`) |
| GET | `/api/areas/:id` | Área como GeoJSON Feature |
| GET | `/api/areas/:id/info` | Metadados da área, sem geometria |
| GET | `/api/areas/:id/especies` | Espécies ameaçadas (CR/EN/VU) dentro da área |
| GET | `/api/ocorrencias?especie_id=&categoria=&bioma=&fonte=&bbox=&limit=` | Ocorrências como GeoJSON |
| GET | `/api/ocorrencias/tiles/:z/:x/:y.mvt` | Tile vetorial das ocorrências |
| GET | `/api/ocorrencias/gbif?especie=panthera+onca` | Proxy GBIF (tempo real, cache 5min) |
| GET | `/api/ocorrencias/:id` | Detalhe da ocorrência |
| GET | `/api/dashboard` | Stats das views materializadas + agregações do dashboard |
| GET | `/api/deteccoes/jobs` | Jobs do ML service (proxy, só com o serviço rodando) |
| GET | `/api/deteccoes/jobs/:id` | Detalhe de um job do ML service (proxy) |

## Consultas de exemplo

```sql
-- Espécies ameaçadas dentro de uma UC (via ocorrencia_area)
SELECT * FROM especies_em_area(1);

-- UCs onde a espécie X ocorre
SELECT * FROM areas_protegem_especie(
    (SELECT id FROM especie WHERE nome_cientifico = 'panthera onca')
);

-- Quantas ocorrências caem numa UC
SELECT contar_ocorrencias_em_area(1);

-- Busca full-text
SELECT * FROM buscar_especies('onca');

-- Dashboard (views materializadas)
SELECT * FROM dashboard_stats;
SELECT * FROM ranking_especies_categoria;
SELECT * FROM ucs_por_esfera;
SELECT * FROM especies_por_uc;

-- Atualizar views após carga/alteração
SELECT refresh_dashboard();

-- Auditoria
SELECT tabela, operacao, timestamp, dados_novos
FROM log_auditoria ORDER BY timestamp DESC LIMIT 20;
```

## Recursos de BD implementados

- **PostGIS**: colunas `geometry`, `ST_Contains`, `ST_AsGeoJSON`, `ST_AsMVT`, índices **GIST**.
- **Constraints**: `CHECK`, `UNIQUE`, FKs com `ON DELETE RESTRICT/CASCADE/SET NULL`.
- **Enums/Domínios**: `categoria_ameaca_tipo`, `esfera_tipo`, `fonte_ocorrencia_tipo`, `nome_cientifico_dom`, `uf_dom`, etc.
- **Triggers**: auditoria, validação de geometria, sincronização lat/lon ↔ geom, `atualizado_em`,
  manutenção de `ocorrencia_area`, invalidação de cache.
- **Funções**: `especies_em_area`, `areas_protegem_especie`, `contar_ocorrencias_em_area`, `buscar_especies`, `refresh_dashboard`.
- **Views materializadas**: `dashboard_stats`, `especies_por_uc`, `ranking_especies_categoria`, `ucs_por_esfera` (todas com índice único).
- **Denormalização controlada**: `ocorrencia_area` (relação espacial pré-calculada) e `area_tile` (tiles pré-gerados).
- **Full-Text Search**: tsvector gerado + índice GIN em português.
- **Índices compostos e parciais**: espécie+data, categoria+status, parciais em detecções/imagens.
- **Cache**: LRU in-memory no backend + `cache_metadata` no BD.
- **Migrations**: sistema customizado com journal, SHA-256 e transações atômicas.
