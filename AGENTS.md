# BioGuardians — Project Info

> **Migração PostgreSQL → MySQL em andamento** (fork de `TheJhou/BioGuardians`).
> Feito: schema (`db/`), `migrate.sh`, smoke test, compose (dev), CI e backend (driver
> `mysql2`, SQL das rotas, tiles MVT gerados no Node).
> Falta: scripts de `scripts/data/`, ML service (asyncpg) e deploy/VM.
> Até lá, os loaders e o ML service ainda falam PostgreSQL e não rodam contra este banco.

## Stack
- **Database**: MySQL 8.4 LTS (tipos espaciais nativos, SRID 4326)
- **Backend**: Node.js 22 + Express 5 + TypeScript (porta 3001)
- **Frontend**: React 19 + Vite + TypeScript + MapLibre GL (via react-map-gl) + MapTiler Cloud + Chart.js
- **ML Service**: Python 3.11 + FastAPI + OpenRouter (Claude Sonnet 4); Qwen2-VL-2B local opcional (porta 8001, local com GPU)
- **Infra**: Docker Compose, Nginx, Oracle Cloud VM (produção) + máquina local com RTX 4060 (ML)
- **CI/CD**: GitHub Actions — `ci.yml` (PRs e branches ≠ main) e `deploy.yml` (push na main); ML service não é deployado
- **Observabilidade**: OpenTelemetry, Grafana, Tempo, Prometheus, Loki

## Estrutura do repositório
```
backend/        API Express (routes/, cache/, db/, middleware/, telemetry/, utils/, tileStore.ts, tileWarmup.ts)
backend/scripts/generateAreaTiles.ts   pré-geração dos tiles MVT das UCs
frontend/       SPA React (pages/, components/, lib/, api/client.ts, styles/)
db/             migrate.sh, migrations/ (001–002), tests/smoke_test.sql
ml-service/     FastAPI + CLI de classificação de camera trap
scripts/data/   importadores e enriquecimento (MMA, CNUC, GBIF, speciesLink, Wikipedia, iNaturalist)
observability/ + otel-collector-config.yaml   configs da stack Grafana
infra/nginx/bioguardians.conf                 Nginx da VM (TLS + subdomínios)
docs/           PROJECT_PLAN, DATA_DICTIONARY, ERD, OBSERVABILITY, AREA_TILE_CACHE
```

## Migrations
- Sistema customizado em `db/migrate.sh` (sem ferramentas de terceiros)
- Journal table: `schema_migrations` (filename + checksum SHA-256)
- DDL no MySQL faz commit implícito: uma migration **não** é transacional. O registro no journal só é gravado depois que o arquivo inteiro rodou sem erro; por isso toda migration precisa ser idempotente (se falhar no meio, roda de novo)
- Se um arquivo já aplicado for alterado (hash diferente), o `migrate.sh` **aborta** — nunca edite uma migration aplicada; crie a próxima
- O `deploy.yml` exige numeração sequencial (`001`, `002`, …) sem buracos
- Idempotência no MySQL: `CREATE TABLE IF NOT EXISTS` com índices dentro do `CREATE TABLE` (não existe `CREATE INDEX IF NOT EXISTS` nem `ADD COLUMN IF NOT EXISTS`), `DROP ... IF EXISTS` + `CREATE` para triggers/procedures, `INSERT ... ON DUPLICATE KEY UPDATE` para dados de referência
- Triggers e procedures ficam entre `DELIMITER $$` … `DELIMITER ;` (o `migrate.sh` usa o cliente `mysql`, que entende `DELIMITER`)
- O usuário da aplicação só cria triggers com `log_bin_trust_function_creators=1` no servidor (já no compose e no CI)
- O cliente `mysql` usa `latin1` por padrão: sempre `--default-character-set=utf8mb4` (o `migrate.sh` já faz isso)
- Comandos: `sh db/migrate.sh`, `--status`, `--dry-run`

### Migrations existentes
1. `001_initial.sql` — schema MySQL consolidado, equivalente ao estado final das antigas migrations PostgreSQL 001–005 (que ficam no histórico do git): tabelas, índices espaciais, triggers, procedure `refresh_dashboard()`, tabelas de agregados do dashboard e dados de referência (categorias, biomas, estados)
2. `002_planar_geom_validation.sql` — os triggers de `area_protegida` validam a geometria no plano (`ST_IsValid(ST_SRID(geom, 0))`, mesmo critério do PostGIS). Em SRID 4326 o MySQL valida no elipsoide e recusava 94 das 3.371 UCs de produção

## Comandos úteis
- Subir banco (Docker): `docker compose up -d db`
- Aplicar migrations (Docker): `docker compose run --rm migrate`
- Aplicar migrations (nativo): `sh db/migrate.sh`
- Status das migrations: `sh db/migrate.sh --status`
- Smoke tests: `docker exec -i bioguardians-db mysql --default-character-set=utf8mb4 -u $DB_USER -p$DB_PASSWORD $DB_NAME < db/tests/smoke_test.sql`
- Resetar banco: `docker compose down -v && docker compose up -d db && docker compose run --rm migrate`
- Conectar: `docker exec -it bioguardians-db mysql --default-character-set=utf8mb4 -u $DB_USER -p $DB_NAME`
- Refresh dos agregados do dashboard: `CALL refresh_dashboard();`
- Pré-gerar tiles das UCs: `cd backend && npm run generate-area-tiles`
- Typecheck: `npm run typecheck` em `backend/` e `frontend/`
- Subir produção: `cd ~/bioguardians && sudo docker compose -f stack.yml pull && sudo docker compose -f stack.yml up -d`

## Decisões de modelagem
- SRID 4326 (WGS84) para todas as geometrias. **Ordem dos eixos**: no MySQL, em SRID 4326, `ST_X` devolve a **latitude** e `ST_AsText`/`ST_GeomFromText` usam lat/lon. Use `ST_Longitude`/`ST_Latitude`, GeoJSON (`ST_GeomFromGeoJSON`/`ST_AsGeoJSON`, sempre lon/lat) ou `ST_SRID(POINT(lon, lat), 4326)`. O smoke test 8 pega a inversão
- Cálculos espaciais em SRID 4326 são geodésicos no MySQL (no PostGIS `geometry` eram planares). Na cópia do backup de produção, `ST_Contains` deu exatamente as mesmas ligações ocorrência↔UC que o PostGIS
- Validação de geometria: no plano (migration 002). Mesmo assim, o validador do MySQL (Boost) recusa alguns polígonos que o PostGIS (GEOS) aceita (18 UCs de produção). Ao migrar dados do PostgreSQL, exporte essas com `ST_MakeValid(ST_SnapToGrid(geom, 1e-7))` (~1 cm; variação de área ≤ 0,0002%)
- Colação padrão `utf8mb4_0900_as_cs` (sensível a acento e caixa, como no PostgreSQL). Busca sem acento: `col COLLATE utf8mb4_0900_ai_ci LIKE ...` (substitui `unaccent(lower(...))`)
- `nome_cientifico` com `CHECK` (lowercase, trim, ≥ 4 caracteres); UF `CHAR(2)` com `CHECK` de maiúsculas
- Enums do PostgreSQL viram `ENUM` na coluna; `rank` é palavra reservada no MySQL 8 — sempre `` `rank` ``
- Taxonomia hierárquica com auto-referência (reino → gênero)
- Auditoria por triggers em `especie` e `area_protegida` com `JSON_OBJECT` coluna a coluna (o MySQL não tem `to_jsonb(NEW)`); em `area_protegida` o polígono vira `geom_md5`. Coluna nova nessas tabelas = atualizar os triggers de auditoria
- `geom` de `ocorrencia` e `deteccao` é derivada de lat/lon por trigger (não precisa ser informada no `INSERT`)
- Relação ocorrência ↔ UC pré-calculada em `ocorrencia_area` (trigger na escrita) — leitura sem `ST_Contains`
- O MySQL não tem views materializadas: `dashboard_stats`, `especies_por_uc`, `ranking_especies_categoria` e `ucs_por_esfera` são tabelas comuns preenchidas por `CALL refresh_dashboard()` (numa transação)
- Removidos no porte por não terem uso: `buscar_especies` + `tsv_busca`, `contar_ocorrencias_em_area`, `cache_metadata`. `especies_em_area` e `areas_protegem_especie` (funções que retornavam tabela) passam para SQL nas rotas
- Tiles MVT das UCs persistidos em `area_tile` (z3–z6 pré-gerados, demais sob demanda)
- **Procedures/triggers**: nunca dê a uma variável local o nome de uma coluna (`WHERE genero_id = genero_id` compara a variável com ela mesma e casa todas as linhas). Use o prefixo `v_`

## Frontend
- Rotas: `/` → redireciona para `/home`; `/home`, `/dashboard`, `/mapa`, `/especies`, `/especies/:id`; `/sobre` é placeholder; qualquer outra → `/home`
- Páginas em `src/pages/` montadas sobre `components/layout/Layout` (Header + Footer)
- Cliente da API centralizado em `src/api/client.ts` (`VITE_API_URL`, default `http://localhost:3001/api`)
- Mapa: tiles vetoriais MVT de áreas e ocorrências servidos pelo backend + basemap MapTiler (`VITE_MAPTILER_API_KEY`)
- Efeitos visuais isolados em `src/lib/` (glow, tilt, scroll-reveal, animated-tabs, lazy-image)
- Estilos globais em `src/styles/`, com entrada única `index.css` (importado no `main.tsx`). A ordem dos `@import` define a cascata: `tokens.css` (variáveis + fonte) → `base.css` → `layout.css` → `components/*.css` → `pages/*.css`. Cada media query fica no arquivo da área que ela afeta
- Fonte Inter carregada por `<link>` (com `preconnect`) no `frontend/index.html`, não por `@import` no CSS
- Breakpoints: use só 1400 / 1024 / 768 / 560px (documentados em `tokens.css`). 1024 é onde some a nav do header e aparece a bottom-nav fixa — páginas que rolam até o fim precisam de `padding-bottom` a partir de 1024
- `!important` só nos `<canvas>` do Chart.js (única forma de vencer o estilo inline que a lib grava); não use em outros lugares
- Estilo inline só para valores dinâmicos (cor vinda de dados, posição calculada); valores fixos vão para o CSS
- CSS próprio ao lado do componente só em `Glow*.css` e `lib/*` (importados pelo próprio componente)
- Paleta (verde escuro) em `styles/tokens.css`: cada cor existe uma vez como canais RGB (`--rgb-accent: 68 216 142`); as cores `--color-*` e as transparências derivam deles (`rgb(var(--rgb-accent) / 0.25)`). Não escreva hex/rgba da paleta direto no CSS: use `var(--color-*)` ou `rgb(var(--rgb-*) / a)`. Trocar a paleta = editar só os `--rgb-*`
- Cores de **dados** (categoria de ameaça, categoria de UC) têm fonte única em `constants/index.ts` (`CATEGORY_COLORS`, `UC_CATEGORY_COLORS`), usada pelo mapa, pela legenda e pelo `components/ui/CategoryBadge.tsx` — nunca escreva essas cores em CSS ou inline. O mapa pinta UCs por `categoria_uc` (não por esfera)
- Gráficos (Chart.js) leem a paleta dos tokens CSS em tempo de execução via `constants/chartTheme.ts` (`getChartTheme()`, `tokenColor()`); não escreva hex/rgba nos componentes de gráfico
- Nomes de tokens: `--color-bg`, `--color-surface`, `--color-field`, `--color-primary`, `--color-accent`, `--color-accent-strong`, `--color-text`, `--color-text-muted`, `--color-text-faint`, `--color-border`, `--color-danger`, `--color-header-bg`, `--gradient-bg`, `--glass-*`, `--nav-*`, `--shadow*`, `--radius-*`
- Busca de espécies com scroll infinito (15 por página)
- Responsivo: header com navegação mobile + bottom nav, grids adaptáveis

## Backend
- **API somente leitura: só rotas GET.** Não criar POST/PUT/DELETE; dados entram pelos scripts de `scripts/data/`, migrations e ML service. CORS aceita só `GET`
- Rotas: `/api/health`, `/api/biomas|estados|categorias|taxonomia`, `/api/especies`, `/api/areas`, `/api/ocorrencias`, `/api/dashboard`, `/api/deteccoes` (lista completa no README)
- SQL escrito direto nas rotas via `db/pool.ts` (`mysql2`, sem ORM); pool `DB_POOL_MAX` (default 20). Placeholders `?` posicionais; arrays viram lista (`IN (?)` com `[1, 2]`)
- O driver devolve DECIMAL/SUM/AVG como `number` (`decimalNumbers`), DATE como `'YYYY-MM-DD'` e DATETIME em UTC; colunas JSON e `ST_AsGeoJSON` já chegam como objeto
- Busca de espécies (`?busca=`) e de UCs: `col COLLATE utf8mb4_0900_ai_ci LIKE ?` (sem acento e sem caixa: "onca" acha "Onça")
- MySQL não tem `NULLS LAST`: `ORDER BY col IS NULL, col` (em `DESC` o NULL já vai para o fim)
- Tiles MVT: `/api/areas/tiles/:z/:x/:y.mvt` (tabela `area_tile` sem filtros; LRU 1h com filtros) e `/api/ocorrencias/tiles/:z/:x/:y.mvt` (LRU 1h + warm-up de z3–z5 no boot, desligável com `TILE_WARMUP=false`)
- O MySQL não tem `ST_AsMVT`: o banco só filtra pelo índice espacial (`MBRIntersects` com o envelope do tile, a partir do z3) e devolve GeoJSON; recorte, projeção e codificação ficam em `src/mvt.ts` (`geojson-vt` + `vt-pbf`). Camadas `uc` (`id`, `categoria_uc`) e `ocorrencia` (`id`, `especie_id`, `categoria_ameaca`)
- Simplificação de UCs: `SIMPLIFIED_GEOM_SQL` em `tileStore.ts`. O `ST_Simplify` do MySQL só aceita SRID 0 (`ST_SRID(geom, 0)`) e devolve `NULL` quando o polígono inteiro é menor que a tolerância, por isso o fallback em cadeia (sem ele as UCs pequenas somem nos zooms baixos)
- Envelope/bbox em WKT sempre com `ST_GeomFromText(?, 4326, 'axis-order=long-lat')` (`ENVELOPE_SQL`); para pontos, o recorte exato é `BETWEEN` em `lat`/`lon`
- Proxy ML (somente leitura): `GET /api/deteccoes/jobs`, `GET /api/deteccoes/jobs/:id` → `ML_SERVICE_URL` (default `http://localhost:8001`); só funciona com o ML service rodando
- Cache LRU em memória (`CACHE_TTL_MS`, `CACHE_MAX`) com TTL por rota; sem invalidação ativa (a API não escreve)
- OpenTelemetry condicional (só ativa com `OTEL_EXPORTER_OTLP_ENDPOINT`)
- Sem testes automatizados; o CI roda apenas `tsc --noEmit`

## ML Service (classificação de camera trap com IA externa)
- Microserviço Python em `ml-service/` (FastAPI; PyTorch só para o modelo local/treino)
- **Roda localmente** na máquina com GPU (RTX 4060 8GB VRAM) — NÃO é deployado na VM de produção
- Porta 8001, container Docker `bioguardians-ml` (apenas em `docker-compose.yml` dev)
- Grava direto no PostgreSQL (asyncpg) — o backend só lê via proxy `/api/deteccoes`

### Jornada técnica (o que foi testado e por que mudou)
1. **Satélite (CBERS-4A)** — descartado: resolução ~2m/pixel insuficiente para detectar fauna
2. **YOLO (detecção + crop)** — descartado: muitos falsos positivos e crops ruins prejudicavam a classificação
3. **VLM local fine-tuned (Qwen2-VL-2B + QLoRA)** — descartado como classificador de produção:
   - v2: LoRA r=16, 3.313 imagens, 26 espécies → ~70% em 20 imgs
   - v3: LoRA r=48 (com confiança no target) → ~65%
   - v4: LoRA r=16, 9.348 imagens, 68 espécies → ~62% em 50 imgs
   - Problema: acurácia baixa demais e confiança não calibrada (erros com conf=0.99)
4. **IA externa via API (ATUAL)** — OpenRouter + Claude Sonnet 4, pago por token:
   - Acurácia muito superior; no primeiro batch real, 99,9% das imagens respondidas foram classificadas
   - Custo por imagem — exige cota de créditos na conta OpenRouter

### Pipeline atual
```
Wildlife Insights CSV → download autenticado (GraphQL) → cache local
    → OpenRouter/Claude Sonnet 4 classifica a imagem completa (VLM_CONCURRENCY em paralelo)
    → dedup: mesmo image_id, mesmo hash SHA-256 ou mesmo deployment+timestamp → pula
    → se confiança >= 0.3: salva espécie + ocorrência no banco
    → se confiança < 0.3 ou sem espécie: salva como rejeitada
    → ocorrência duplicada (mesma espécie + data + local) → não duplica
```

### Resultado do primeiro processamento real (job 29)
- ~19k imagens em cache; 9.450 elegíveis (resto: blank/humano/sem label)
- **1.559 classificadas com sucesso** → 886 ocorrências, 49 espécies distintas (40 novas)
- 7.155 falharam com `402` (cota OpenRouter esgotada) — ficaram como `rejected` no banco
- Para reprocessar: `DELETE FROM deteccao WHERE job_id=29 AND status='rejected'; UPDATE imagem_job SET status='pending' WHERE job_id=29 AND status='completed';` e rodar o ingest de novo

### Modelo VLM local (mantido apenas para experimentos)
- Artefatos de treino (v3/v4) em `/models/qwen2vl-finetuned-v*` — fora do caminho de produção
- `LOCAL_VLM_ENABLED` tem default `true` no código, no compose e no `.env.example`; defina `false` para usar só OpenRouter (recomendado)
- `LOCAL_VLM_PATH` — caminho do modelo local (default no compose: `models/qwen2vl-finetuned`)
- `WI_CACHE_ONLY=true` impede download de novas imagens (processa só o cache)

### Histórico de treinamentos (Qwen2-VL-2B + QLoRA)

Todos os treinos usaram `Qwen/Qwen2-VL-2B-Instruct` como base, QLoRA 4-bit
na RTX 4060 (8GB VRAM), dataset Wildlife Insights.

#### v2 — melhor resultado em amostra pequena
- LoRA r=16, alpha=32
- Dataset: 3.313 imagens, 26 espécies
- Resultado: **~70% em 20 imagens de teste**
- Lição: dataset menor = classes mais fáceis; acurácia alta mas limitada

#### v3 — confiança no target do modelo
- LoRA r=48
- Dataset: 3.313 imagens, 26 espécies
- 3.535 steps, 5 epochs, eval loss ~5.31
- 55,4M parâmetros treináveis (2,45% do total)
- Resultado: **~65% em 20 imagens** — piorou vs v2
- Lição: aumentar LoRA rank não melhorou; confiança embutida no treino
  ficou não-calibrada (erros com conf=0.80-0.99)

#### v4 — mais dados, mais espécies
- LoRA r=16, alpha=32
- Dataset: 9.348 imagens em cache, 68 espécies
- Split: 7.964 treino / 1.384 validação
- Batch=2, grad_accum=4, 5 epochs, 4.980 steps
- 18,5M parâmetros treináveis (0,83% do total)
- Resultado: **60% em 20 imagens, 62% em 50 imagens**
- Lição: 68 espécies é muito mais difícil que 26; o modelo local
  simplesmente não tem capacidade suficiente pra esse problema

#### Por que desistimos do modelo local
- Melhor cenário possível: ~70% em amostra pequena, ~62% em dataset real
- Confiança retornada pelo modelo não era calibrada
- Erros frequentes com confiança alta — inutilizável em produção
- OpenRouter/Claude Sonnet 4 deu ~99,9% de aproveitamento no primeiro batch

### Fonte de dados — Wildlife Insights
- Dataset CSV com metadados + URLs autenticadas para download de imagens
- Autenticação: POST `/v1/auth/sign-in` → token → POST `/graphql-data-file` → URL GCS assinada
- Filtros: blank, human, no_species são pulados; só imagens com espécie rotulada são processadas
- Cache: imagens baixadas ficam no volume Docker `bioguardians_ml_images`
- Estatísticas do dataset: 34.190 imagens total, ~19k baixadas, 9.680 treináveis, 68 espécies

### Arquivos principais
- `app/pipeline.py` — orquestra classificação concorrente + dedup + persistência
- `app/local_classifier.py` — classificador (local opcional + OpenRouter)
- `app/sources/camera_trap.py` — source Wildlife Insights (CSV + download autenticado + cache-only)
- `app/sources/local_dir.py` — source para pasta local (testes/debug)
- `app/train/prepare_dataset.py` — baixa imagens e prepara dataset JSONL para fine-tune
- `app/train/finetune.py` — fine-tune Qwen2-VL-2B com QLoRA
- `app/config.py` — configurações via env
- `app/db.py` — acesso ao PostgreSQL (asyncpg), dedup por hash/evento
- `app/main.py` — FastAPI app + worker loop
- `app/cli.py` — CLI com comandos `ingest`, `classify`, `status`, `prepare-dataset`, `finetune`
- `tests/` — scripts avulsos de experimento (inferência, análise de dataset, medição de VRAM); não é uma suíte automatizada

### Comandos CLI
```bash
# Processar imagens (classifica com OpenRouter e salva no banco)
docker exec bioguardians-ml python -m app.cli ingest --source camera_trap --data-dir /data/wi --limit 50

# Preparar dataset para fine-tune (baixa ~9.680 imagens)
docker exec bioguardians-ml python -m app.cli prepare-dataset --data-dir /data/wi --output-dir /data/dataset

# Fine-tunar Qwen2-VL-2B (requer GPU, ~2-4h na RTX 4060) — apenas experimentos
docker exec bioguardians-ml python -m app.cli finetune --dataset-dir /data/dataset --output-dir /models/qwen2vl-finetuned

# Reclassificar detecções pendentes de jobs antigos
docker exec bioguardians-ml python -m app.cli classify --all

# Status de um job
docker exec bioguardians-ml python -m app.cli status --job-id 29
```

### Endpoints
- `POST /ingest` — cria job de processamento (worker processa em background)
- `POST /classify` — reclassifica detecções pendentes de jobs antigos (YOLO legacy)
- `GET /jobs` — lista jobs recentes
- `GET /jobs/{id}` — detalhes do job + detecções
- `GET /jobs/{id}/progress` — progresso detalhado (imagens, classificadas, rejeitadas)
- `GET /health` — status do serviço + modelo carregado

### Banco de dados
- Tabelas: `deteccao_job`, `imagem_job`, `deteccao`, `modelo_ml`, `especie`, `ocorrencia` (todas criadas na `001`)
- `deteccao.metodo_classificacao` = 'ai' (CHECK constraint só permite 'ai' ou 'heuristic')
- `deteccao.modelo_ia` = 'anthropic/claude-sonnet-4' (ou 'qwen2vl-local' em experimentos)
- `deteccao.status` (enum `deteccao_status`): 'detected', 'classified', 'rejected', 'inconclusive'
- `deteccao.geom` sincronizada com lat/lon por trigger (migration 002)
- `ocorrencia.confianca_ia` — confiança da IA (NUMERIC 5,4), exibida como % no frontend
- `ocorrencia.fonte` inclui 'camera_trap', 'deteccao_ia' e 'deteccao_satelite' (legado)
- `especie.categoria_fonte` — procedência da categoria de ameaça: 'mma', 'iucn', 'ai', 'manual'
- **A IA NÃO atribui categoria de ameaça** — novas espécies nascem como 'DD'/'ai'; `scripts/data/validate_categories.mjs` corrige depois via MMA/IUCN
- Categorias válidas: CR, EN, VU, NT, LC, DD, **NE** (Não Avaliada — usada para não-fauna: humanos, domésticos)
- `imagem_job` tem checkpoint único por `(source, source_image_id)` — idempotente
- Dedup adicional: `image_hash` (SHA-256) e `deployment_id`+`timestamp` pulam registros idênticos

### Validação de categorias de ameaça
- Script: `scripts/data/validate_categories.mjs` — roda com `--dry-run` pra ver o que mudaria
- Hierarquia: **MMA** (lista oficial, `input/mma_especies.csv`) > **IUCN** (via GBIF API) > **AI** (mantém mas marca 'ai' = não confiável)
- Também marca espécies não-fauna (humanos, animais domésticos) como `status='inativo'`

### Env vars
- `DATABASE_URL` — string de conexão PostgreSQL (obrigatória)
- `OPENROUTER_API_KEY` — chave OpenRouter (classificador principal)
- `OPENROUTER_MODEL` — modelo (default: `anthropic/claude-sonnet-4`)
- `LOCAL_VLM_ENABLED` — default `true`; `false` = só OpenRouter
- `LOCAL_VLM_PATH` — caminho do modelo local fine-tuned
- `YOLO_DEVICE` — device do VLM local: `cuda` (default) ou `cpu` (reaproveita o nome da var)
- `WI_EMAIL` / `WI_PASSWORD` — credenciais Wildlife Insights
- `WI_CACHE_ONLY` — `true` = não baixa imagens novas, processa só o cache
- `SPECIES_CONFIDENCE_THRESHOLD` — threshold de aceitação (default: 0.3)
- `IMAGE_STORAGE_DIR` — diretório de cache de imagens (default: `/app/images`)
- `VLM_CONCURRENCY` — chamadas OpenRouter simultâneas (default: 8)
- `HTTP_TIMEOUT` — timeout das chamadas OpenRouter em segundos (default: 120)
- `DB_POOL_MAX` — tamanho do pool asyncpg (default: 20)

## Carga de dados
- Scripts em `scripts/data/` (detalhes em `scripts/data/README.md`)
- `load_mma_especies.mjs` — importa lista de espécies ameaçadas do MMA (CSV)
- `load_cnuc_ucs.mjs` — importa Unidades de Conservação do CNUC (shapefile, lido com a lib `shapefile`). Lê o encoding do `.cpg` (UTF-8): a lib usa windows-1252 por padrão e isso já corrompeu 2.671 nomes
- `fix_uc_names_encoding.mjs` — correção única (já aplicada em produção em 2026-09-23) dos nomes com dupla codificação; simula por padrão, `--commit` aplica
- `load_gbif_ocorrencias.mjs` — importa ocorrências da API GBIF
- `load_specieslink_ocorrencias.mjs` — importa ocorrências do speciesLink (exige `SPLINK_API_KEY`)
- `enrich_species_descriptions.mjs` — resumos via Wikipedia (PT/EN), Wikidata, iNaturalist e EOL
- `enrich_species_images.mjs` — imagens via iNaturalist, Wikimedia Commons (Wikidata P18) e Wikipedia
- `validate_categories.mjs` — padroniza categorias de ameaça (MMA > IUCN > AI)
- Após carga de UCs, rode `npm run generate-area-tiles` no backend (ou `DELETE FROM area_tile;` para regenerar sob demanda)

## Observabilidade (OpenTelemetry + Grafana stack)

### Arquitetura
```
Backend (Node.js) ──OTLP/gRPC :4317 (traces + métricas)──> OTel Collector ──> Tempo (traces)
                  ──OTLP/HTTP :4318 (logs)───────────────>                ├──> exporter Prometheus :8889 ← scrape do Prometheus
                                                                          └──> Loki (OTLP/HTTP)
Grafana (:3000) lê de Prometheus + Tempo + Loki
```

### Arquivos
- `backend/src/telemetry/instrumentation.ts` — SDK Node + auto-instrumentações (Express, pg, http)
- `backend/src/telemetry/logger.ts` — logger OTel nativo (JSON em prod, pretty em dev)
- `backend/src/telemetry/metrics.ts` — métricas customizadas (cache hit/miss, errors)
- `backend/src/middleware/requestLogger.ts` — log de cada request HTTP
- `otel-collector-config.yaml` — config do Collector (receivers, processors, exporters)
- `observability/prometheus.yml` — scrape do Collector (`otel-collector:8889`)
- `observability/tempo.yml` — Tempo (storage local em `/var/tempo`)
- `observability/loki.yml` — Loki (filesystem em `/loki`, OTLP nativo)
- `observability/grafana/provisioning/` — datasources + dashboard provider
- `observability/grafana/dashboards/bioguardians-overview.json` — dashboard "BioGuardians — Overview"
- `docker-compose.observability.yml` — overlay (5 serviços + injeta `OTEL_*` no backend)

### Como subir
```bash
# Dev: app + observabilidade
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d

# Imagens de produção fora da VM (app + observabilidade)
docker compose -f docker-compose.prod.yml -f docker-compose.observability.yml up -d
```
Na VM, o `stack.yml` já inclui a stack de observabilidade.

### Acesso
- Grafana: http://localhost:3000 (admin/admin no overlay; na VM a senha vem de `GRAFANA_ADMIN_PASSWORD`)
- Prometheus: http://localhost:9090
- Tempo: http://localhost:3200
- Loki: http://localhost:3100/ready

### Instrumentação
- **Auto-instrumentação**: `@opentelemetry/auto-instrumentations-node` instrumenta Express, mysql2, http automaticamente. A instrumentação do mysql2 só gera spans: o histograma `db.client.operation.duration` é gravado à mão em `db/pool.ts`, e as métricas de pool (`db_client_connection_*`) não existem mais (o mysql2 não as expõe)
- **Condicional**: só ativa se `OTEL_EXPORTER_OTLP_ENDPOINT` estiver definida (no-op sem overlay)
- **gRPC**: traces + metrics via gRPC (:4317); logs via HTTP (:4318)
- **Filtros**: `/api/health` não gera spans (ruído)
- **Pool DB**: max=`DB_POOL_MAX` (20), connectionTimeout=10s, idleTimeout=30s

### Métricas disponíveis
- `http_server_request_duration_seconds` (histogram) — latência por rota
- `db_client_operation_duration_seconds` (histogram) — duração das queries
- `bioguardians_cache_hits_total` / `bioguardians_cache_misses_total` (counter) — cache hit rate
- `bioguardians_errors_total` (counter) — erros por tipo/status

## Produção com domínio próprio

### Arquitetura
```
Internet → Cloudflare (DNS + HTTPS) → Nginx na VM → Docker
  financemobile.com.br              → 127.0.0.1:8080  (frontend)
  api.financemobile.com.br          → 127.0.0.1:3001  (backend)
  grafana.financemobile.com.br      → 127.0.0.1:3000  (Grafana)
  pgadmin.financemobile.com.br      → 127.0.0.1:5050  (pgAdmin — direto na VM)
  portainer.financemobile.com.br    → 127.0.0.1:9443  (Portainer — direto na VM)
```

### Variáveis de ambiente
- `VITE_API_URL=https://api.financemobile.com.br/api` (frontend, build-arg — deve terminar em `/api`)
- `VITE_MAPTILER_API_KEY` (frontend, build-arg — obrigatório para o mapa)
- `FRONTEND_URL=https://financemobile.com.br` (backend — também vira `CORS_ORIGIN` no `stack.yml`)

### Deploy
- O workflow `deploy.yml` roda em push na `main` (ignora commits que só mudam `*.md`): `prepare` (detecta mudanças + valida numeração das migrations) → `build` (backend/frontend no GHCR; serviço sem mudança só é re-taggeado) → `migrate` (migrations + smoke test no banco de produção) → `generate-stack` (renderiza `stack.yml` com secrets) → `deploy` (SCP + `docker compose -f stack.yml up -d` na VM)
- A VM usa `stack.yml` (não `docker-compose.prod.yml`)
- **ML service NÃO é deployado na VM** — roda localmente na máquina com GPU (RTX 4060)
- PostgreSQL roda nativamente na VM; o backend conecta via `DATABASE_URL` montada a partir dos secrets
- O container do frontend é um Nginx servindo só o build estático; a API é acessada pelo subdomínio `api.` via Nginx da VM

### Portas
- Abertas para Internet: 80, 443, 22
- Frontend `127.0.0.1:8080` e backend `127.0.0.1:3001` — só o Nginx da VM acessa
- Fechar no firewall: 3000, 3100, 3200, 4317, 4318, 5050, 5432, 8889, 9090 (o `stack.yml` publica várias dessas em `0.0.0.0`)

### Nginx
- Config no repo: `infra/nginx/bioguardians.conf`
- Configurar na VM em: `/etc/nginx/sites-available/bioguardians`
- Certificado Cloudflare Origin CA: `/etc/cloudflare/origin-ca.crt`
- Chave privada: `/etc/cloudflare/origin-ca.key`
- NÃO commitar certificado/chave no Git.
- pgAdmin e Portainer rodam direto na VM (fora do `stack.yml`)

### Cloudflare
- `A @`, `A api`, `A grafana`, `A pgadmin`, `A portainer` → IP público VM (Proxied)
- SSL/TLS → Full (strict)

### Comandos na VM
```bash
# Instalar Nginx (Oracle Linux)
sudo dnf install -y nginx

# Copiar config
sudo cp infra/nginx/bioguardians.conf /etc/nginx/sites-available/bioguardians
sudo ln -sf /etc/nginx/sites-available/bioguardians /etc/nginx/sites-enabled/

# Certificado Origin CA
sudo mkdir -p /etc/cloudflare
sudo chown root:root /etc/cloudflare/origin-ca.crt /etc/cloudflare/origin-ca.key
sudo chmod 600 /etc/cloudflare/origin-ca.key

# Testar e recarregar
sudo nginx -t
sudo systemctl reload nginx

# Reiniciar aplicação
cd ~/bioguardians
sudo docker compose -f stack.yml pull
sudo docker compose -f stack.yml up -d
```
