# BioGuardians

BioGuardians reúne dados espaciais sobre espécies ameaçadas, áreas protegidas,
ocorrências de fauna e alertas de monitoramento ambiental no Brasil. O projeto
inclui uma API de consulta, uma interface web e processos de carga independentes.

O banco e o backend usam **MySQL 8.4**. A API pública é somente leitura: todas
as rotas são `GET`. Os dados entram por migrations, importadores e workers.

## Componentes

- **Banco:** MySQL 8.4, com geometrias nativas em SRID 4326.
- **Backend:** Node.js 22, Express 5 e TypeScript (`backend/`, porta 3001).
- **Frontend:** React 19, Vite, MapLibre e MapTiler (`frontend/`, porta 5173).
- **Monitoramento ambiental:** importadores INPE/DETER no backend, tabelas
  próprias e worker de coleta agendada.
- **ML service:** FastAPI para classificação de imagens de camera trap.
- **Observabilidade:** OpenTelemetry, Grafana, Tempo, Prometheus e Loki.

O porte do sistema para MySQL segue em andamento: os importadores existentes de
`scripts/data/` e partes do ML service ainda dependem de PostgreSQL e não devem
ser considerados compatíveis com este banco até serem portados. A ingestão
INPE/DETER descrita abaixo já usa o backend e o MySQL.

## Estrutura

```text
backend/          API, importadores ambientais e monitor-worker
frontend/         aplicação web
db/               migrations MySQL e smoke test
scripts/data/     importadores e enriquecimento do domínio de espécies
ml-service/       serviço de classificação de imagens
observability/    configurações da stack de observabilidade
infra/nginx/      configuração Nginx da VM
docs/             plano, dicionário, ERD e decisões de modelagem
```

## Executar localmente

Crie `.env` a partir do exemplo e configure as credenciais do MySQL e a chave do
MapTiler (`VITE_MAPTILER_API_KEY`). Depois suba o banco, aplique as migrations e
inicie a API, a interface e o worker:

```bash
cp .env.example .env
docker compose up -d db
docker compose run --rm migrate
docker compose up -d backend frontend monitor-worker
```

- Interface: <http://localhost:5173>
- API: <http://localhost:3001/api/health>
- Banco: `localhost:3306` (ou a porta definida por `DB_PORT`)

O `monitor-worker` consulta as fontes ativas e respeita a frequência configurada
no catálogo. Para subir a stack de observabilidade junto, use:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

## Migrations

As migrations numeradas ficam em `db/migrations/` e são aplicadas por
`db/migrate.sh`. O MySQL confirma DDL implicitamente; cada migration deve ser
idempotente. O runner registra nome e hash SHA-256 em `schema_migrations` e
interrompe a execução se o arquivo de uma migration já aplicada for alterado.
Para mudar o schema, crie uma migration seguinte em vez de editar uma aplicada.

```bash
sh db/migrate.sh             # aplica pendentes
sh db/migrate.sh --status    # mostra o estado
sh db/migrate.sh --dry-run   # lista o que seria aplicado
```

Migrations atuais:

| Migration | Conteúdo |
|---|---|
| `001_initial.sql` | Schema MySQL principal, tabelas, triggers, procedure e dados de referência |
| `002_planar_geom_validation.sql` | Ajusta a validação planar das geometrias das UCs |
| `003_monitoramento_ambiental.sql` | Cria o domínio e as fontes-base de monitoramento |
| `004_activate_terrabrasilis_deter.sql` | Configura e ativa as camadas públicas DETER Amazônia e Cerrado |

## Dados de monitoramento ambiental

O domínio de monitoramento fica separado de `ocorrencia` e `deteccao`. Ele
registra execuções de coleta, eventos com geometria e status inicial de
atendimento, além da relação espacial com Unidades de Conservação.

### Fontes integradas

| Fonte | Formato e conteúdo | Identificador no catálogo |
|---|---|---|
| INPE / Programa Queimadas | CSV diário de focos de calor do Brasil; eventos pontuais | `inpe_queimadas_diario_br` |
| TerraBrasilis / DETER Amazônia | WFS GeoJSON, polígonos da camada `deter-amz:deter_amz` | `terrabrasilis_deter_amazonia_wfs` |
| TerraBrasilis / DETER Cerrado | WFS GeoJSON, polígonos da camada `deter-cerrado-nb:deter_cerrado` | `terrabrasilis_deter_cerrado_wfs` |

As camadas DETER consultadas são as versões públicas, com atraso aproximado de
uma semana; o feed antecipado diário requer acesso restrito e não faz parte
desta integração. O importador solicita a geometria em EPSG:4326 e conserva os
polígonos completos. Consulte [a modelagem e as decisões de ingestão](docs/ENVIRONMENTAL_MONITORING_MODEL.md).

Para executar uma carga manual, use o backend com `DATABASE_URL` apontando para
o MySQL. A opção `--dry-run` analisa os dados sem persistir uma execução ou
eventos:

```bash
cd backend
npm run monitor:import -- --source inpe_queimadas_diario_br --date 2026-11-05
npm run monitor:import -- --source terrabrasilis_deter_amazonia_wfs --since 2026-10-01 --dry-run
npm run monitor:import -- --source terrabrasilis_deter_cerrado_wfs --janela-dias 30 --limit 500
```

Fontes CSV usam `--date`; fontes WFS usam `--since` ou `--janela-dias`. Para
usar um arquivo local, passe `--file <caminho>`. Importações repetidas são
idempotentes pela combinação de fonte e identificador externo. A reimportação
atualiza os dados publicados e preserva o atendimento existente.

### API e atendimento

Todas as rotas abaixo são `GET`; não há endpoint para alterar status ou enviar
dados. Novos eventos recebem o status inicial `novo` e um registro inicial no
histórico. Os valores `em_andamento` e `resolvido` existem no modelo do banco,
mas a API atual não oferece transições para eles. A tabela de prioridade também
está preparada no schema, porém o cálculo de prioridade ainda não está
implementado.

| Rota | Descrição |
|---|---|
| `GET /api/monitoramento/eventos` | Lista eventos em GeoJSON; aceita filtros por tipo, fonte, bioma, estado, período, status, prioridade e bbox |
| `GET /api/monitoramento/eventos/:id` | Detalhe do evento, histórico de atendimento e UCs intersectadas |
| `GET /api/monitoramento/resumo` | Totais agrupados por tipo, status, prioridade e bioma |
| `GET /api/monitoramento/fontes` | Fontes ativas e resultado da última coleta |
| `GET /api/monitoramento/execucoes/:id` | Detalhes e contagens de uma execução de coleta |

## Outros dados e serviços

- As cargas de espécies, UCs e ocorrências estão descritas em
  [`scripts/data/README.md`](scripts/data/README.md); esses scripts ainda
  precisam ser portados para MySQL antes de rodarem neste banco.
- O ML service é executado localmente e ainda usa integração PostgreSQL; veja
  [`ml-service/`](ml-service/) e as instruções de configuração antes de usá-lo.
- A arquitetura de observabilidade está em
  [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md).

## Documentação de dados

- [Plano do projeto](docs/PROJECT_PLAN.md)
- [Modelagem de monitoramento ambiental](docs/ENVIRONMENTAL_MONITORING_MODEL.md)
- [Dicionário de dados](docs/DATA_DICTIONARY.md)
- [Modelo entidade-relacionamento](docs/ERD.md)
- [Cache persistente de tiles](docs/AREA_TILE_CACHE.md)
