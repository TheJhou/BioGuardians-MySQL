# Cache persistente de tiles — `generateAreaTiles.ts`

As Unidades de Conservação têm polígonos grandes e com muitos vértices. Para
evitar repetir o preparo dos tiles em cada consulta, o projeto persiste os tiles
MVT sem filtros na tabela MySQL `area_tile`.

## Armazenamento

A tabela é criada pela migration `001_initial.sql`:

```sql
CREATE TABLE area_tile (
    z         SMALLINT    NOT NULL,
    x         INT         NOT NULL,
    y         INT         NOT NULL,
    tile      MEDIUMBLOB  NOT NULL,
    gerado_em DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (z, x, y)
);
```

## Geração

`backend/scripts/generateAreaTiles.ts` calcula a extensão geográfica das UCs,
enumera os tiles slippy map nessa extensão e usa `backend/src/tileStore.ts` para
gerar e gravar cada tile. Por padrão, pré-gera os zooms 3 a 6; os limites podem
ser passados como argumentos. A geração é idempotente: um upsert substitui o
tile existente para a chave `(z, x, y)`.

```bash
cd backend
npm run generate-area-tiles          # zooms 3–6
npm run generate-area-tiles -- 3 8   # zooms 3–8
```

O MySQL usa o índice espacial para filtrar geometrias pelo envelope do tile e
aplica `ST_Simplify` antes de devolver GeoJSON. O simplificador do MySQL exige
SRID cartesiano, por isso a query troca temporariamente o SRID para 0 sem
alterar as coordenadas longitude/latitude e aplica um fallback para polígonos
pequenos. A codificação MVT é feita no Node.js (`geojson-vt` + `vt-pbf`); o
MySQL não fornece `ST_AsMVT`.

## Fluxo da API

```text
GET /api/areas/tiles/:z/:x/:y.mvt
  ├─ sem filtros (esfera, categoria, bioma):
  │    ├─ consulta area_tile e devolve o tile persistido
  │    └─ se não existir, gera no Node.js, grava e devolve
  └─ com filtros:
       └─ gera a variante filtrada sob demanda e mantém em cache LRU
```

Tiles de UCs sem filtro são persistidos; combinações filtradas usam cache em
memória, pois a chave da tabela não inclui os parâmetros de filtro. A geração
dinâmica usa a mesma rotina de simplificação e codificação que o script em
lote.

## Atualização dos tiles

A API é somente leitura. Depois de inserir ou alterar UCs por um processo de
carga, regenere os tiles:

```bash
cd backend && npm run generate-area-tiles
```

Também é possível apagar os tiles para que sejam reconstruídos sob demanda:

```sql
DELETE FROM area_tile;
```

## Arquivos relacionados

| Arquivo | Papel |
|---|---|
| `db/migrations/001_initial.sql` | Cria a tabela `area_tile` |
| `backend/src/tileStore.ts` | Filtra, simplifica, lê e grava tiles |
| `backend/src/mvt.ts` | Codifica tiles MVT no Node.js |
| `backend/src/routes/areas.ts` | Rota de tiles e cache de filtros |
| `backend/scripts/generateAreaTiles.ts` | Pré-geração em lote |
