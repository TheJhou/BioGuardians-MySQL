# BioGuardians — Dicionário de Dados

Resumo das entidades do schema MySQL nas migrations `001`–`004`. As definições
completas de coluna, chave e constraint estão nos arquivos de migration. O
domínio ambiental e suas regras estão detalhados em
[`ENVIRONMENTAL_MONITORING_MODEL.md`](ENVIRONMENTAL_MONITORING_MODEL.md); o
diagrama está em [`ERD.md`](ERD.md).

## Convenções do schema

- Banco: MySQL 8.4, charset `utf8mb4`, collation `utf8mb4_0900_as_cs`.
- Geometrias: SRID 4326 (WGS84); GeoJSON mantém coordenadas longitude/latitude.
  No MySQL, para SRID 4326, `ST_X` e `ST_Y` seguem a ordem de eixos definida pelo
  SRS; use `ST_Longitude` e `ST_Latitude` quando precisar de cada coordenada.
- Data/hora: `DATETIME(6)` armazenado em UTC; datas sem horário usam `DATE`.
- JSON de origem e auditoria usa o tipo `JSON` do MySQL.
- Categorias e estados fechados são colunas `ENUM` ou `CHECK`; não há tipos
  enum/domínio globais separados como no schema PostgreSQL anterior.
- O MySQL não tem views materializadas: os agregados do dashboard são tabelas
  comuns atualizadas por `CALL refresh_dashboard()`.

## Tabelas de referência

### `categoria_ameaca`

Referência de categorias de conservação. Chave `codigo` (`CR`, `EN`, `VU`, `NT`,
`LC`, `DD`, `NE`), nome, descrição e ordem de prioridade.

### `bioma`

Biomas brasileiros, com identificador, nome e descrição. Usada por espécies,
áreas protegidas e eventos ambientais.

### `estado`

Unidades federativas, identificadas pela sigla `uf`, com nome e região.

### `taxon`

Hierarquia taxonômica autorreferenciada (`parent_id`): reino, filo, classe,
ordem, família e gênero. `especie.genero_id` aponta para um táxon de gênero.

## Biodiversidade e áreas protegidas

### `especie`

Registro da espécie, identificado por `nome_cientifico`. Guarda nome popular,
categoria de ameaça e sua procedência (`categoria_fonte`), gênero, descrição,
imagem, status (`ativo`, `inativo`, `revisao`) e datas de criação/atualização.
`nome_cientifico` deve estar em minúsculas, sem espaços externos e ter ao menos
quatro caracteres.

### `especie_bioma` e `especie_estado`

Tabelas de junção N:N entre espécies e biomas, e espécies e estados. A chave
primária composta impede duplicatas.

### `area_protegida`

Unidade de Conservação com nome, categoria (`protecao_integral` ou
`uso_sustentavel`), esfera (federal, estadual, municipal ou particular), bioma,
área em hectares e geometria `MULTIPOLYGON SRID 4326`. A geometria tem índice
espacial.

### `ocorrencia`

Ocorrência de uma espécie, com latitude, longitude, data, fonte, identificador
de origem e confiança de IA opcional. `geom` é um `POINT SRID 4326` sincronizado
com latitude/longitude por trigger.

### `ocorrencia_area`

Relação espacial N:N pré-calculada entre ocorrência e UC. Triggers mantêm a
relação quando uma ocorrência é gravada/movida ou quando a geometria de uma UC
muda; as consultas usam a junção por IDs.

### `log_auditoria`

Auditoria de alterações em `especie` e `area_protegida`, mantida por triggers.
Guarda tabela, operação, identificador do registro, usuário, horário e JSON
anterior/novo. Para UCs, a geometria é representada por um hash em vez do
polígono completo.

## Serviço de classificação de imagens

### `deteccao_job`

Execução de processamento, com datas e metadados da origem, totais de imagens e
detecções, estado, conclusão e eventual erro.

### `imagem_job`

Checkpoint por imagem, associado ao job. Guarda fonte e identificador externo,
hash, caminho, coordenadas, câmera/deployment, estado, contagem de detecções e
erro. A restrição única por `(source, source_image_id)` dá suporte à ingestão
idempotente.

### `deteccao`

Resultado associado ao job e, opcionalmente, à imagem e à espécie. Guarda
identificação, confiança, coordenadas, geometria derivada, método, modelo e
estado (`detected`, `classified`, `rejected`, `inconclusive`).

### `modelo_ml`

Catálogo de modelos com nome, versão, tipo, caminho, acurácia opcional, indicador
de atividade e data de criação.

> O ML service ainda depende de PostgreSQL/`asyncpg`; estas tabelas existem no
> schema MySQL, mas o serviço não está portado para gravar nelas.

## Cache e agregados

### `area_tile`

Tiles MVT completos das UCs, armazenados como `MEDIUMBLOB` e identificados pela
chave `(z, x, y)`. Ver [`AREA_TILE_CACHE.md`](AREA_TILE_CACHE.md).

### Tabelas de agregados

- `dashboard_stats` — totais de espécies, categorias, áreas e ocorrências.
- `especies_por_uc` — espécies encontradas em cada UC.
- `ranking_especies_categoria` — total por categoria de ameaça.
- `ucs_por_esfera` — totais e área por esfera administrativa.

São tabelas comuns preenchidas pela procedure `refresh_dashboard()`; não são
views materializadas.

### `schema_migrations`

Journal do runner `db/migrate.sh`, com nome do arquivo, checksum SHA-256 e data
de aplicação.

## Monitoramento ambiental

As tabelas foram adicionadas pela migration `003_monitoramento_ambiental.sql`;
a migration `004_activate_terrabrasilis_deter.sql` configura e ativa os WFS
públicos do DETER Amazônia e Cerrado.

### `monitor_fonte`

Catálogo de fontes: código, nome, órgão, produto, formato (`csv`/`wfs`), endpoint,
camada, CRS, frequência, orientação de atribuição e estado ativo. Fontes ativas:
`inpe_queimadas_diario_br`, `terrabrasilis_deter_amazonia_wfs` e
`terrabrasilis_deter_cerrado_wfs`.

### `monitor_tipo_evento`

Referência dos códigos `foco_calor` e `alerta_deter`, com nome, descrição e
estado ativo.

### `monitor_execucao`

Uma tentativa de coleta por fonte: status, janela, parâmetros JSON, checksum,
erro e contagens de registros lidos, novos, atualizados, ignorados e rejeitados.

### `monitor_evento`

Evento normalizado, único por `(fonte_id, id_externo)`. Inclui última execução,
tipo, geometria, data e precisão, bioma/estado, município e código IBGE, campos
de fogo (`satelite`, `risco_fogo`, `frp_mw`), classe/área de alerta DETER, JSON
original e horários de importação/atualização. A geometria é ponto para focos e
polígono/multipolígono para alertas DETER.

### `monitor_prioridade`

Avaliação opcional 1:1 com evento: versão do algoritmo, scores de risco,
recência e sensibilidade, score final, nível e horário. O cálculo ainda não foi
implementado e a ingestão não preenche esta tabela.

### `monitor_atendimento` e `monitor_atendimento_historico`

O primeiro guarda status (`novo`, `em_andamento`, `resolvido`), responsável e
datas; o segundo guarda status anterior/novo, horário, ator e observação. Um
evento importado começa com status `novo` e uma entrada inicial no histórico.
A API é somente GET e não oferece transições para os demais status.

### `monitor_evento_uc`

Relação N:N entre evento e UC, com tipo (`contem_ponto` ou
`intersecta_poligono`), área de interseção em hectares quando aplicável e data
do cálculo. É recalculada pelo processo de ingestão.

## Migrations atuais

| Arquivo | Responsabilidade |
|---|---|
| `001_initial.sql` | Schema principal MySQL, triggers, procedure, agregados e referências |
| `002_planar_geom_validation.sql` | Critério planar de validação para geometrias de UCs |
| `003_monitoramento_ambiental.sql` | Tabelas e fontes-base do monitoramento |
| `004_activate_terrabrasilis_deter.sql` | Fontes WFS públicas ativas do DETER Amazônia e Cerrado |
