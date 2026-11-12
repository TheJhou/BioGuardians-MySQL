# BioGuardians - Data Loading Scripts

This directory contains scripts to populate the database with real data
from official Brazilian biodiversity sources, enrich species with
descriptions and images, and standardize threat categories.

## Data Sources

### 1. MMA — Ministério do Meio Ambiente

**What**: Official list of threatened species in Brazil.

**Legal basis**:
- **Portaria MMA Nº 148, de 7 de junho de 2022** — Lista de espécies
  ameaçadas de extinção da fauna brasileira (298 espécies).
- **Portaria MMA Nº 445, de 18 de dezembro de 2014** — Lista de espécies
  ameaçadas de extinção da flora brasileira (2.113 espécies).
- **Portaria MMA Nº 443, de 17 de dezembro de 2014** — Lista de espécies
  ameaçadas de extinção da fauna (atualizada pela 148/2022).
- **Portaria MMA Nº 444, de 17 de dezembro de 2014** — Lista de espécies
  aquáticas ameaçadas de extinção.

**Categories used** (enum `categoria_ameaca_tipo`, labels as stored in `categoria_ameaca`):
| Code | Label in the app | IUCN meaning |
|------|------------------|--------------|
| CR | Criticamente em Perigo | Critically Endangered |
| EN | Entrando em Extinção | Endangered |
| VU | Alto Risco de Entrar em Extinção | Vulnerable |
| NT | Em Ameaça | Near Threatened |
| LC | Sem Risco | Least Concern |
| DD | Sem Dados para Avaliar | Data Deficient |
| NE | Não Avaliada | Not Evaluated (also used for non-wildlife detected by camera traps) |

**Where to download**:
- Fauna: https://www.gov.br/mma/pt-br/temas/conservacao-da-biodiversidade/fauna-brasileira
- Flora: https://www.gov.br/mma/pt-br/temas/conservacao-da-biodiversidade/flora-brasileira

**Format**: CSV (semicolon-separated, UTF-8)
**Sample**: `input/mma_especies.csv` — 97 real threatened species included.

---

### 2. CNUC — Cadastro Nacional de Unidades de Conservação

**What**: National registry of protected areas (UCs) in Brazil, managed
by MMA. Contains boundaries, categories, administration sphere, and
metadata for all federal, state, municipal, and private UCs.

**Legal basis**:
- **Lei Nº 9.985, de 18 de julho de 2000** — SNUC (Sistema Nacional
  de Unidades de Conservação da Natureza).
- **Decreto Nº 4.340, de 22 de agosto de 2002** — Regulamentação do SNUC.

**Categories (SNUC)**:
| Our enum | SNUC category | Description |
|----------|---------------|-------------|
| protecao_integral | Proteção Integral | Uso indireto dos recursos (não consome) |
| uso_sustentavel | Uso Sustentável | Uso direto sustentável dos recursos |

**Administration spheres**: federal, estadual, municipal, particular.

**Where to download**:
- CNUC portal: http://cnuc.mma.gov.br/
- Direct download (shapefile): http://cnuc.mma.gov.br/cnuc/app/gerenciar_dados_abertos

**Format**: Shapefile (SHP, SHX, DBF, PRJ) — read directly with the
`shapefile` npm package (no `shp2pgsql` needed).
**SRID**: 4326 (WGS84).

---

### 3. GBIF — Global Biodiversity Information Facility

**What**: International network that provides open access to biodiversity
data from museums, herbaria, research institutions, and citizen science.

**API**:
- Base URL: `https://api.gbif.org/v1` (`GBIF_API_BASE`)
- Endpoint: `/occurrence/search`
- Parameters used: `country=BR`, `scientificName`, `hasCoordinate=true`, `limit`
- Rate limit: 500ms between requests (self-imposed)
- No API key required

**Data fields extracted**:
| GBIF field | Our column | Description |
|------------|------------|-------------|
| decimalLatitude | lat | Latitude in decimal degrees |
| decimalLongitude | lon | Longitude in decimal degrees |
| eventDate | data_evento | Date of observation/collection |
| institutionCode | base_registro | Source institution code |

GBIF is also used by `validate_categories.mjs` to look up the IUCN category.

---

### 4. speciesLink — Rede speciesLink

**What**: Brazilian network of biological collections (herbaria, museums)
maintained by CRIA.

**API**:
- Base URL: `https://specieslink.net/ws/1.0/search`
- Parameters: `scientificname`, `format=json`, `limit`, `apikey`
- **Requires an API key** (`SPLINK_API_KEY` in `.env`, get one at
  https://specieslink.net/ws/1.0/). Without it, the script skips with a warning.
- Rate limit: 1000ms between requests (self-imposed)

GBIF already aggregates much of speciesLink's data, so this loader is optional.

---

## Prerequisites

```bash
# From the repo root: copy .env and set DB credentials
cp .env.example .env

# Install dependencies (pg, csv-parse, shapefile, dotenv)
cd scripts/data
npm install
```

All scripts read the **root** `.env` (`../../.env`).

## Available Scripts

### 1. MMA — Espécies Ameaçadas

**Script**: `load_mma_especies.mjs` (`npm run load:mma`)

```bash
node load_mma_especies.mjs                          # uses input/mma_especies.csv
node load_mma_especies.mjs --file=input/custom.csv  # custom CSV
```

**CSV format** (UTF-8, semicolon-separated):
```
nome_cientifico;nome_popular;categoria;reino;filo;classe;ordem;familia;genero;biomas;estados
panthera onca;onça-pintada;VU;Animalia;Chordata;Mammalia;Carnivora;Felidae;Panthera;Amazônia,Mata Atlântica;AC,AM,AP,MT,MS,PA,RO,RR,TO,MA,PI,BA,MG,SP,PR,SC,RS
```

**What it does**:
1. Parses the CSV
2. Creates the taxonomy chain (reino → filo → classe → ordem → familia → genero)
3. Inserts species with `ON CONFLICT (nome_cientifico) DO NOTHING`
4. Links species to biomas (`especie_bioma`) and estados (`especie_estado`)

### 2. CNUC — Unidades de Conservação

**Script**: `load_cnuc_ucs.mjs` (`npm run load:cnuc`)

```bash
# Extract .shp/.shx/.dbf/.prj from CNUC into input/cnuc_ucs/ (git-ignored)
node load_cnuc_ucs.mjs
node load_cnuc_ucs.mjs --dir=input/custom_cnuc
node load_cnuc_ucs.mjs --file=input/cnuc_ucs/ucs.shp
```

**What it does**:
1. Reads the shapefile with the `shapefile` library, using the encoding from
   the `.cpg` file (UTF-8 for CNUC). The library defaults to windows-1252,
   which corrupted 2,671 UC names in the original load (fixed by
   `fix_uc_names_encoding.mjs`, see below)
2. Skips non-UC records (`limite` ≠ `uc`) and inactive UCs (`situacao` ≠ `ativo`)
3. Maps `grupo` → `categoria_uc_tipo` and `esfera` → `esfera_tipo`
4. Detects the bioma from the record attributes
5. Inserts into `area_protegida` (`ST_Multi(ST_GeomFromText(...))`) with
   `ON CONFLICT (nome) DO NOTHING`
6. Calls `refresh_dashboard()` at the end

The database triggers fill `ocorrencia_area` for existing occurrences. After a
bulk UC load, regenerate the map tiles:

```bash
cd ../../backend && npm run generate-area-tiles
```

### 3. GBIF — Ocorrências

**Script**: `load_gbif_ocorrencias.mjs` (`npm run load:gbif`)

```bash
node load_gbif_ocorrencias.mjs                           # all active species, 50 per species
node load_gbif_ocorrencias.mjs --especie="panthera onca" # one species
node load_gbif_ocorrencias.mjs --limit=100               # custom limit per species
```

**What it does**:
1. Queries active species from `especie`
2. Calls the GBIF API for each one (`country=BR`)
3. Skips duplicates via `(especie_id, lat, lon, fonte='gbif')`
4. Inserts into `ocorrencia` (the `geom` column and `ocorrencia_area` are filled by triggers)
5. Calls `refresh_dashboard()` at the end

### 4. speciesLink — Ocorrências

**Script**: `load_specieslink_ocorrencias.mjs` (`npm run load:splink`)

```bash
node load_specieslink_ocorrencias.mjs
node load_specieslink_ocorrencias.mjs --especie="panthera onca"
```

Same flow as GBIF, with `fonte='specieslink'`. Requires `SPLINK_API_KEY`.

### 5. Enriquecer resumos de espécies

**Script**: `enrich_species_descriptions.mjs` (`npm run enrich:descriptions`)

```bash
node enrich_species_descriptions.mjs
node enrich_species_descriptions.mjs --dry-run --limit=10
```

**What it does**:
1. Queries species without `descricao`
2. Tries Wikipedia (PT/EN) by scientific and popular name, Wikipedia search,
   Wikidata, iNaturalist and EOL
3. Validates that the text mentions the species
4. Updates `especie.descricao` (300ms between species)

### 6. Enriquecer imagens de espécies

**Script**: `enrich_species_images.mjs` (`npm run enrich:images`)

```bash
node enrich_species_images.mjs
node enrich_species_images.mjs --dry-run --limit=50
```

**What it does**: for species without `imagem_url`, tries the iNaturalist
default photo, then the Wikimedia Commons image from Wikidata (P18), then the
Wikipedia page thumbnail. Updates `especie.imagem_url` (300ms between species).

### 7. Validar categorias de ameaça

**Script**: `validate_categories.mjs` (no npm alias)

```bash
node validate_categories.mjs --dry-run  # report only
node validate_categories.mjs            # apply
```

**What it does**:
1. Resolves each species' category by priority: **MMA** CSV (`categoria_fonte='mma'`)
   → **IUCN** via GBIF (`'iucn'`) → keeps the current value marked as `'ai'`
2. Marks non-wildlife species detected by camera traps (humans, domestic
   animals) as `status='inativo'`

Run it after the ML service creates new species (the AI never assigns a
threat category — new species start as `DD`/`ai`).

### 8. Corrigir nomes de UC com dupla codificação (one-off)

**Script**: `fix_uc_names_encoding.mjs` — applied in production on 2026-09-23.

```bash
node fix_uc_names_encoding.mjs            # dry run (ROLLBACK)
node fix_uc_names_encoding.mjs --commit   # apply
```

Reverts names like `RESERVA BIOLÃ“GICA` → `RESERVA BIOLÓGICA`. Every fixed
name is checked against the original shapefile read as UTF-8; any mismatch,
collision with an existing name or leftover corrupted text aborts with
ROLLBACK. Old names are saved to `backups/` (git-ignored) before writing.
Runs in a single transaction with the generic audit trigger disabled only
inside it (it would copy each polygon into `log_auditoria`, ~244 MB); a
compact audit row (old name → new name) is written for each UC instead.

### 9. Importar o backup CSV do PostgreSQL (MySQL)

**Script**: `import_pg_backup.mjs` — applied in production (EC2) on 2026-11-12
from `bioguardians_dados_csv_2026-09-30.zip`.

Unlike the loaders above, it targets the MySQL schema. It does not connect to
the database: it turns the backup (one CSV per table) into a `.sql` file.

```bash
node import_pg_backup.mjs <csv-dir> import.sql [--repair-ids=27,149,...]
mysql --default-character-set=utf8mb4 --max-allowed-packet=64M -u ... -p <db> < import.sql
```

- Aborts unless `especie`, `area_protegida` and `ocorrencia` are empty. Keeps
  the original ids.
- Triggers compute `geom` and `ocorrencia_area`; missing links from the
  backup are added afterwards (for the 2026-09-30 backup both sets matched).
- MySQL's validator rejects some polygons that PostGIS accepts and has no
  `ST_MakeValid`. Run once without `--repair-ids` on a throwaway MySQL: the SQL
  lists the rejected UCs (and skips them). Pass those ids to repair them with
  JSTS (1e-7° grid + `buffer(0)`, area change capped at 0.1%). The
  2026-09-30 backup needed these 41 ids:
  `27,149,168,282,377,523,552,624,778,879,903,970,995,1060,1136,1665,1723,2092,2173,2183,2237,2273,2279,2311,2318,2371,2438,2511,2513,2514,2522,2524,2538,2539,2615,2649,2693,2840,2973,3155,3258`.
- The audit rows written by the triggers during the load are replaced by the
  backup's `log_auditoria`. UC polygons are dropped from it (`geom_md5: null`).
- Ends with `CALL refresh_dashboard()`. Afterwards run `DELETE FROM area_tile;`
  and restart the backend so no tile generated from the empty database
  survives, then pre-generate tiles (`npm run generate-area-tiles` in
  `backend/`, or request them through the API).
- In production it ran as root with `SET SESSION sql_log_bin = 0;` prepended,
  so the ~150 MB of UC inserts did not go to the binlog on a small disk.

### Legacy SQL (one-off, already applied in production)

- `cleanup_mock_data.sql` — removed the mock data inserted by the old
  `008_seed_data.sql`
- `fix_migration_checksum.sql` — updated the stored checksum of the old
  migration `008`

Both refer to the pre-consolidation migrations (now merged into
`001_initial.sql`) and should not be needed on a new database.

## Environment Variables

Read from the root `.env`:

```
DB_USER=bioguard
DB_PASSWORD=***
DB_NAME=bioguardians
DB_HOST=localhost
DB_PORT=5432
GBIF_API_BASE=https://api.gbif.org/v1
SPLINK_API_KEY=            # optional, only for speciesLink
```

## Running Order

For a full data load from scratch:

```bash
npm run load:mma             # 1. species
npm run load:cnuc            # 2. protected areas
npm run load:gbif            # 3. occurrences
npm run load:splink          #    (optional)
npm run enrich:descriptions  # 4. enrichment
npm run enrich:images
node validate_categories.mjs # 5. standardize categories
```

`npm run load:all` runs MMA + GBIF + speciesLink only — **it does not load CNUC**.

## Notes

- Scripts are **idempotent** — running twice won't duplicate data
- MMA and CNUC require manual download of the source files
- GBIF needs no API key; speciesLink does
- All inserts use parameterized queries
- The `fonte` column in `ocorrencia` tracks the data source
- Rate limits are self-imposed to be respectful to public APIs

## Data License

| Source | License | Notes |
|--------|---------|-------|
| MMA | Open data (Decreto 10.046/2019) | Government open data |
| CNUC | Open data (Decreto 10.046/2019) | Government open data |
| GBIF | CC-BY 4.0 | Attribution required |
| speciesLink | CC-BY 4.0 | Attribution required, varies by collection |
