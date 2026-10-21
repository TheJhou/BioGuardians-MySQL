-- ============================================================
-- BioGuardians - Schema inicial (MySQL 8.4)
--
-- Porte do schema PostgreSQL/PostGIS (antigas migrations 001-005)
-- para MySQL. Estado final equivalente, com estas diferenças:
--
--   * Enums/domínios viram ENUM + CHECK na própria coluna.
--   * Views materializadas viram tabelas comuns, preenchidas por
--     CALL refresh_dashboard().
--   * Funções que retornavam tabela (especies_em_area,
--     areas_protegem_especie) saem do banco: o SQL fica nas rotas.
--   * Um trigger por tabela/momento/evento (MySQL não tem
--     "INSERT OR UPDATE" nem "UPDATE OF coluna").
--   * Removidos por não terem uso: buscar_especies + tsv_busca,
--     contar_ocorrencias_em_area, cache_metadata (e triggers).
--
-- Geometria em SRID 4326. ATENÇÃO à ordem dos eixos: no MySQL, para
-- SRID 4326, ST_X devolve a LATITUDE e ST_AsText/ST_GeomFromText usam
-- lat/lon. Use sempre ST_Longitude/ST_Latitude, GeoJSON
-- (ST_GeomFromGeoJSON/ST_AsGeoJSON, sempre lon/lat) ou
-- ST_SRID(POINT(lon, lat), 4326).
--
-- Colação padrão utf8mb4_0900_as_cs (sensível a acento e caixa, igual
-- ao PostgreSQL). Buscas sem acento usam COLLATE utf8mb4_0900_ai_ci.
--
-- DDL no MySQL faz commit implícito: esta migration não é transacional.
-- Idempotente (IF NOT EXISTS / DROP + CREATE / ON DUPLICATE KEY).
-- Exige log_bin_trust_function_creators=1 (ou SUPER) para os triggers.
-- ============================================================

ALTER DATABASE CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;

-- ---------- Journal de migrations ----------
CREATE TABLE IF NOT EXISTS schema_migrations (
    id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    filename   VARCHAR(255) NOT NULL UNIQUE,
    checksum   VARCHAR(64)  NOT NULL,
    applied_at DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);

-- ---------- Tabelas de referência ----------
CREATE TABLE IF NOT EXISTS categoria_ameaca (
    codigo           CHAR(2)     NOT NULL PRIMARY KEY,
    nome             VARCHAR(60) NOT NULL UNIQUE,
    descricao        TEXT,
    ordem_prioridade SMALLINT    NOT NULL UNIQUE,
    CONSTRAINT categoria_ameaca_codigo_chk
        CHECK (codigo IN ('CR','EN','VU','NT','LC','DD','NE'))
);

CREATE TABLE IF NOT EXISTS bioma (
    id        SMALLINT    NOT NULL AUTO_INCREMENT PRIMARY KEY,
    nome      VARCHAR(40) NOT NULL UNIQUE,
    descricao TEXT,
    CONSTRAINT bioma_nome_chk CHECK (nome = TRIM(nome))
);

CREATE TABLE IF NOT EXISTS estado (
    uf     CHAR(2)     NOT NULL PRIMARY KEY,
    nome   VARCHAR(60) NOT NULL UNIQUE,
    regiao VARCHAR(20) NOT NULL,
    CONSTRAINT uf_formato_chk CHECK (uf = UPPER(uf)),
    CONSTRAINT estado_regiao_chk
        CHECK (regiao IN ('Norte','Nordeste','Centro-Oeste','Sudeste','Sul'))
);

-- ---------- Taxonomia ----------
-- "rank" é palavra reservada no MySQL 8: sempre entre crases.
CREATE TABLE IF NOT EXISTS taxon (
    id        INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    nome      VARCHAR(100) NOT NULL,
    `rank`    ENUM('reino','filo','classe','ordem','familia','genero') NOT NULL,
    parent_id INT,
    UNIQUE KEY taxon_nome_rank_uq (nome, `rank`),
    KEY idx_taxon_parent (parent_id),
    KEY idx_taxon_rank (`rank`),
    CONSTRAINT taxon_parent_fk
        FOREIGN KEY (parent_id) REFERENCES taxon(id) ON DELETE RESTRICT
);

-- ---------- Espécie ----------
CREATE TABLE IF NOT EXISTS especie (
    id               INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    nome_cientifico  VARCHAR(200) NOT NULL UNIQUE,
    nome_popular     VARCHAR(120),
    categoria_ameaca CHAR(2)      NOT NULL,
    categoria_fonte  VARCHAR(20)  NOT NULL DEFAULT 'manual',
    genero_id        INT          NOT NULL,
    descricao        TEXT,
    imagem_url       TEXT,
    status           ENUM('ativo','inativo','revisao') NOT NULL DEFAULT 'ativo',
    criado_em        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                  ON UPDATE CURRENT_TIMESTAMP(6),
    KEY idx_especie_categoria (categoria_ameaca),
    KEY idx_especie_status (status),
    KEY idx_especie_nome_popular (nome_popular),
    KEY idx_especie_cat_status (categoria_ameaca, status),
    CONSTRAINT nome_cientifico_formato_chk CHECK (
        nome_cientifico = TRIM(nome_cientifico)
        AND nome_cientifico = LOWER(nome_cientifico)
        AND CHAR_LENGTH(nome_cientifico) >= 4
    ),
    CONSTRAINT especie_categoria_fk
        FOREIGN KEY (categoria_ameaca) REFERENCES categoria_ameaca(codigo)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT especie_genero_fk
        FOREIGN KEY (genero_id) REFERENCES taxon(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS especie_bioma (
    especie_id INT      NOT NULL,
    bioma_id   SMALLINT NOT NULL,
    PRIMARY KEY (especie_id, bioma_id),
    CONSTRAINT espbio_especie_fk
        FOREIGN KEY (especie_id) REFERENCES especie(id) ON DELETE CASCADE,
    CONSTRAINT espbio_bioma_fk
        FOREIGN KEY (bioma_id) REFERENCES bioma(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS especie_estado (
    especie_id INT     NOT NULL,
    estado_uf  CHAR(2) NOT NULL,
    PRIMARY KEY (especie_id, estado_uf),
    CONSTRAINT espest_especie_fk
        FOREIGN KEY (especie_id) REFERENCES especie(id) ON DELETE CASCADE,
    CONSTRAINT espest_estado_fk
        FOREIGN KEY (estado_uf) REFERENCES estado(uf) ON DELETE RESTRICT
);

-- ---------- Área protegida ----------
CREATE TABLE IF NOT EXISTS area_protegida (
    id            INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
    nome          VARCHAR(180)  NOT NULL UNIQUE,
    categoria_uc  ENUM('protecao_integral','uso_sustentavel') NOT NULL,
    esfera        ENUM('federal','estadual','municipal','particular') NOT NULL,
    bioma_id      SMALLINT,
    area_ha       DECIMAL(12,2),
    geom          MULTIPOLYGON  NOT NULL SRID 4326,
    criado_em     DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                ON UPDATE CURRENT_TIMESTAMP(6),
    SPATIAL KEY idx_area_protegida_geom (geom),
    KEY idx_area_protegida_esfera (esfera),
    KEY idx_area_protegida_categoria (categoria_uc),
    KEY idx_area_protegida_bioma (bioma_id),
    CONSTRAINT area_ha_positiva_chk CHECK (area_ha > 0),
    CONSTRAINT areaprot_bioma_fk
        FOREIGN KEY (bioma_id) REFERENCES bioma(id) ON DELETE SET NULL
);

-- ---------- Ocorrência ----------
-- geom é derivada de lat/lon pelo trigger (não precisa ser informada).
CREATE TABLE IF NOT EXISTS ocorrencia (
    id            INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    especie_id    INT          NOT NULL,
    lat           DOUBLE       NOT NULL,
    lon           DOUBLE       NOT NULL,
    geom          POINT        NOT NULL SRID 4326,
    data_evento   DATE,
    fonte         ENUM('gbif','specieslink','carga_inicial','manual','icmbio',
                       'deteccao_satelite','camera_trap','deteccao_ia')
                               NOT NULL DEFAULT 'carga_inicial',
    base_registro VARCHAR(120),
    confianca_ia  DECIMAL(5,4),
    criado_em     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    SPATIAL KEY idx_ocorrencia_geom (geom),
    KEY idx_ocorrencia_fonte (fonte),
    KEY idx_ocorrencia_data (data_evento),
    KEY idx_ocorrencia_especie_data (especie_id, data_evento DESC),
    CONSTRAINT ocorr_lat_chk CHECK (lat BETWEEN -90 AND 90),
    CONSTRAINT ocorr_lon_chk CHECK (lon BETWEEN -180 AND 180),
    CONSTRAINT ocorr_especie_fk
        FOREIGN KEY (especie_id) REFERENCES especie(id) ON DELETE CASCADE
);

-- Relação ocorrência ↔ UC pré-calculada (N:N — UCs podem se sobrepor),
-- mantida pelos triggers de ocorrencia e area_protegida.
CREATE TABLE IF NOT EXISTS ocorrencia_area (
    ocorrencia_id INT NOT NULL,
    area_id       INT NOT NULL,
    PRIMARY KEY (ocorrencia_id, area_id),
    KEY idx_ocorrencia_area_area (area_id),
    CONSTRAINT oa_ocorrencia_fk
        FOREIGN KEY (ocorrencia_id) REFERENCES ocorrencia(id) ON DELETE CASCADE,
    CONSTRAINT oa_area_fk
        FOREIGN KEY (area_id) REFERENCES area_protegida(id) ON DELETE CASCADE
);

-- ---------- Auditoria ----------
CREATE TABLE IF NOT EXISTS log_auditoria (
    id               BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tabela           VARCHAR(60) NOT NULL,
    operacao         ENUM('INSERT','UPDATE','DELETE') NOT NULL,
    registro_id      BIGINT      NOT NULL,
    usuario          VARCHAR(60) NOT NULL DEFAULT (SUBSTRING_INDEX(USER(), '@', 1)),
    `timestamp`      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    dados_anteriores JSON,
    dados_novos      JSON,
    KEY idx_log_tabela_ts (tabela, `timestamp` DESC)
);

-- ---------- ML: jobs, detecções, checkpoint de imagens ----------
CREATE TABLE IF NOT EXISTS deteccao_job (
    id                  INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    bbox                VARCHAR(120),
    data_captura        DATE         NOT NULL,
    satelite            VARCHAR(30),
    instrumento         VARCHAR(30),
    produto             VARCHAR(60),
    scene_id            VARCHAR(120),
    imagem_url          TEXT,
    status              VARCHAR(20)  NOT NULL DEFAULT 'pendente',
    source              VARCHAR(30)  NOT NULL DEFAULT 'satellite',
    data_dir            TEXT,
    project_id          VARCHAR(50),
    p_limit             INT,
    total_imagens       INT          NOT NULL DEFAULT 0,
    imagens_processadas INT          NOT NULL DEFAULT 0,
    total_deteccoes     INT          NOT NULL DEFAULT 0,
    erro                TEXT,
    criado_em           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    concluido_em        DATETIME(6),
    KEY idx_deteccao_job_status (status, criado_em DESC),
    KEY idx_deteccao_job_source (source, status, criado_em DESC),
    CONSTRAINT deteccao_job_status_chk
        CHECK (status IN ('pendente','processando','concluido','erro'))
);

CREATE TABLE IF NOT EXISTS imagem_job (
    id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    job_id          INT          NOT NULL,
    source          VARCHAR(30)  NOT NULL,
    source_image_id VARCHAR(200),
    image_hash      VARCHAR(64),
    path            TEXT,
    lat             DOUBLE,
    lon             DOUBLE,
    `timestamp`     DATETIME(6),
    camera_id       VARCHAR(100),
    project_id      VARCHAR(100),
    deployment_id   VARCHAR(100),
    status          ENUM('pending','processing','detected','classified','completed','failed')
                                 NOT NULL DEFAULT 'pending',
    detection_count INT          NOT NULL DEFAULT 0,
    error           TEXT,
    created_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                 ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY imagem_job_unique (source, source_image_id),
    KEY idx_imagem_job_status (status),
    KEY idx_imagem_job_hash (image_hash),
    KEY idx_imagem_job_job (job_id),
    CONSTRAINT imagem_job_job_fk
        FOREIGN KEY (job_id) REFERENCES deteccao_job(id) ON DELETE CASCADE
);

-- geom é derivada de lat/lon pelo trigger (não precisa ser informada).
CREATE TABLE IF NOT EXISTS deteccao (
    id                   INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    job_id               INT          NOT NULL,
    image_job_id         BIGINT,
    especie_id           INT,
    nome_cientifico      VARCHAR(200),
    confianca            DECIMAL(5,4),
    lat                  DOUBLE       NOT NULL,
    lon                  DOUBLE       NOT NULL,
    geom                 POINT        NOT NULL SRID 4326,
    bbox_pixel           VARCHAR(80),
    recorte_url          TEXT,
    metodo_classificacao VARCHAR(20)  NOT NULL DEFAULT 'heuristic',
    modelo_ia            VARCHAR(100),
    confianca_ia         DECIMAL(5,4),
    status               ENUM('detected','classified','rejected','inconclusive')
                                      NOT NULL DEFAULT 'detected',
    criado_em            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    SPATIAL KEY idx_deteccao_geom (geom),
    KEY idx_deteccao_job (job_id),
    KEY idx_deteccao_especie (especie_id),
    KEY idx_deteccao_metodo (metodo_classificacao),
    KEY idx_deteccao_status (status),
    KEY idx_deteccao_image_job (image_job_id),
    CONSTRAINT deteccao_lat_chk CHECK (lat BETWEEN -90 AND 90),
    CONSTRAINT deteccao_lon_chk CHECK (lon BETWEEN -180 AND 180),
    CONSTRAINT deteccao_metodo_chk CHECK (metodo_classificacao IN ('ai','heuristic')),
    CONSTRAINT deteccao_job_fk
        FOREIGN KEY (job_id) REFERENCES deteccao_job(id) ON DELETE CASCADE,
    CONSTRAINT deteccao_especie_fk
        FOREIGN KEY (especie_id) REFERENCES especie(id) ON DELETE SET NULL,
    CONSTRAINT deteccao_image_job_fk
        FOREIGN KEY (image_job_id) REFERENCES imagem_job(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS modelo_ml (
    id        INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    nome      VARCHAR(100) NOT NULL,
    versao    VARCHAR(30)  NOT NULL,
    tipo      VARCHAR(30)  NOT NULL,
    caminho   TEXT         NOT NULL,
    acuracia  DECIMAL(5,4),
    ativo     BOOLEAN      NOT NULL DEFAULT TRUE,
    criado_em DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY modelo_ml_nome_versao_uq (nome, versao),
    CONSTRAINT modelo_ml_tipo_chk CHECK (tipo IN ('deteccao','classificacao'))
);

-- ---------- Cache persistente dos tiles MVT das UCs ----------
-- Ver docs/AREA_TILE_CACHE.md.
CREATE TABLE IF NOT EXISTS area_tile (
    z         SMALLINT    NOT NULL,
    x         INT         NOT NULL,
    y         INT         NOT NULL,
    tile      MEDIUMBLOB  NOT NULL,
    gerado_em DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (z, x, y)
);

-- ---------- Agregados do dashboard (antigas views materializadas) ----------
-- Preenchidos por CALL refresh_dashboard().
CREATE TABLE IF NOT EXISTS dashboard_stats (
    id                TINYINT       NOT NULL PRIMARY KEY,
    total_especies    BIGINT        NOT NULL,
    total_cr          BIGINT        NOT NULL,
    total_en          BIGINT        NOT NULL,
    total_vu          BIGINT        NOT NULL,
    total_nt          BIGINT        NOT NULL,
    total_lc          BIGINT        NOT NULL,
    total_dd          BIGINT        NOT NULL,
    total_areas       BIGINT        NOT NULL,
    area_total_ha     DECIMAL(16,2) NOT NULL,
    total_ocorrencias BIGINT        NOT NULL
);

CREATE TABLE IF NOT EXISTS especies_por_uc (
    area_id          INT          NOT NULL,
    area_nome        VARCHAR(180) NOT NULL,
    especie_id       INT          NOT NULL,
    nome_cientifico  VARCHAR(200) NOT NULL,
    categoria_ameaca CHAR(2)      NOT NULL,
    PRIMARY KEY (area_id, especie_id)
);

CREATE TABLE IF NOT EXISTS ranking_especies_categoria (
    categoria_ameaca CHAR(2) NOT NULL PRIMARY KEY,
    total            BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS ucs_por_esfera (
    esfera  ENUM('federal','estadual','municipal','particular') NOT NULL PRIMARY KEY,
    total   BIGINT        NOT NULL,
    area_ha DECIMAL(16,2)
);

-- ============================================================
-- Rotinas e triggers (DROP + CREATE = idempotente)
-- ============================================================
DELIMITER $$

DROP PROCEDURE IF EXISTS refresh_dashboard $$
CREATE PROCEDURE refresh_dashboard()
BEGIN
    START TRANSACTION;

    DELETE FROM dashboard_stats;
    INSERT INTO dashboard_stats
    SELECT 1,
           s.total_especies, s.total_cr, s.total_en, s.total_vu,
           s.total_nt, s.total_lc, s.total_dd,
           a.total_areas, a.area_total_ha,
           oc.total_ocorrencias
    FROM (
        SELECT COUNT(*)                                AS total_especies,
               COALESCE(SUM(categoria_ameaca = 'CR'), 0) AS total_cr,
               COALESCE(SUM(categoria_ameaca = 'EN'), 0) AS total_en,
               COALESCE(SUM(categoria_ameaca = 'VU'), 0) AS total_vu,
               COALESCE(SUM(categoria_ameaca = 'NT'), 0) AS total_nt,
               COALESCE(SUM(categoria_ameaca = 'LC'), 0) AS total_lc,
               COALESCE(SUM(categoria_ameaca = 'DD'), 0) AS total_dd
        FROM especie
        WHERE status = 'ativo'
    ) s
    CROSS JOIN (
        SELECT COUNT(*) AS total_areas, COALESCE(SUM(area_ha), 0) AS area_total_ha
        FROM area_protegida
    ) a
    CROSS JOIN (
        SELECT COUNT(*) AS total_ocorrencias
        FROM ocorrencia o
        JOIN especie e ON e.id = o.especie_id
        WHERE e.status = 'ativo'
    ) oc;

    DELETE FROM especies_por_uc;
    INSERT INTO especies_por_uc (area_id, area_nome, especie_id, nome_cientifico, categoria_ameaca)
    SELECT DISTINCT a.id, a.nome, e.id, e.nome_cientifico, e.categoria_ameaca
    FROM ocorrencia_area oa
    JOIN area_protegida a ON a.id = oa.area_id
    JOIN ocorrencia     o ON o.id = oa.ocorrencia_id
    JOIN especie        e ON e.id = o.especie_id
    WHERE e.categoria_ameaca IN ('CR','EN','VU');

    DELETE FROM ranking_especies_categoria;
    INSERT INTO ranking_especies_categoria (categoria_ameaca, total)
    SELECT categoria_ameaca, COUNT(*)
    FROM especie
    WHERE status = 'ativo'
    GROUP BY categoria_ameaca;

    DELETE FROM ucs_por_esfera;
    INSERT INTO ucs_por_esfera (esfera, total, area_ha)
    SELECT esfera, COUNT(*), SUM(area_ha)
    FROM area_protegida
    GROUP BY esfera;

    COMMIT;
END $$

-- ---------- Ocorrência: sync lat/lon <-> geom + junção com UCs ----------
-- No INSERT a geom sempre vem de lat/lon. No UPDATE, se só a geom mudou,
-- deriva lat/lon dela; senão reconstrói a geom a partir de lat/lon.
DROP TRIGGER IF EXISTS trg_ocorrencia_bi $$
CREATE TRIGGER trg_ocorrencia_bi BEFORE INSERT ON ocorrencia
FOR EACH ROW
BEGIN
    SET NEW.geom = ST_SRID(POINT(NEW.lon, NEW.lat), 4326);
END $$

DROP TRIGGER IF EXISTS trg_ocorrencia_bu $$
CREATE TRIGGER trg_ocorrencia_bu BEFORE UPDATE ON ocorrencia
FOR EACH ROW
BEGIN
    IF NOT (ST_AsWKB(NEW.geom) <=> ST_AsWKB(OLD.geom))
       AND NEW.lat <=> OLD.lat
       AND NEW.lon <=> OLD.lon
    THEN
        SET NEW.lon = ST_Longitude(NEW.geom);
        SET NEW.lat = ST_Latitude(NEW.geom);
    ELSE
        SET NEW.geom = ST_SRID(POINT(NEW.lon, NEW.lat), 4326);
    END IF;
END $$

DROP TRIGGER IF EXISTS trg_ocorrencia_ai $$
CREATE TRIGGER trg_ocorrencia_ai AFTER INSERT ON ocorrencia
FOR EACH ROW
BEGIN
    INSERT INTO ocorrencia_area (ocorrencia_id, area_id)
    SELECT NEW.id, a.id
    FROM area_protegida a
    WHERE ST_Contains(a.geom, NEW.geom);
END $$

DROP TRIGGER IF EXISTS trg_ocorrencia_au $$
CREATE TRIGGER trg_ocorrencia_au AFTER UPDATE ON ocorrencia
FOR EACH ROW
BEGIN
    IF NOT (ST_AsWKB(NEW.geom) <=> ST_AsWKB(OLD.geom)) THEN
        DELETE FROM ocorrencia_area WHERE ocorrencia_id = NEW.id;
        INSERT INTO ocorrencia_area (ocorrencia_id, area_id)
        SELECT NEW.id, a.id
        FROM area_protegida a
        WHERE ST_Contains(a.geom, NEW.geom);
    END IF;
END $$

-- ---------- Detecção: sync lat/lon <-> geom ----------
DROP TRIGGER IF EXISTS trg_deteccao_bi $$
CREATE TRIGGER trg_deteccao_bi BEFORE INSERT ON deteccao
FOR EACH ROW
BEGIN
    SET NEW.geom = ST_SRID(POINT(NEW.lon, NEW.lat), 4326);
END $$

DROP TRIGGER IF EXISTS trg_deteccao_bu $$
CREATE TRIGGER trg_deteccao_bu BEFORE UPDATE ON deteccao
FOR EACH ROW
BEGIN
    IF NOT (ST_AsWKB(NEW.geom) <=> ST_AsWKB(OLD.geom))
       AND NEW.lat <=> OLD.lat
       AND NEW.lon <=> OLD.lon
    THEN
        SET NEW.lon = ST_Longitude(NEW.geom);
        SET NEW.lat = ST_Latitude(NEW.geom);
    ELSE
        SET NEW.geom = ST_SRID(POINT(NEW.lon, NEW.lat), 4326);
    END IF;
END $$

-- ---------- Área protegida: validação, auditoria e junção ----------
-- A auditoria troca o polígono por geom_md5 (o polígono inteiro chegava
-- a 6 MB por registro no log).
DROP TRIGGER IF EXISTS trg_area_protegida_bi $$
CREATE TRIGGER trg_area_protegida_bi BEFORE INSERT ON area_protegida
FOR EACH ROW
BEGIN
    DECLARE msg VARCHAR(255);
    IF NOT ST_IsValid(NEW.geom) THEN
        SET msg = LEFT(CONCAT('Geometria invalida para a area protegida ', NEW.nome), 255);
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
    END IF;
    IF ST_IsEmpty(NEW.geom) THEN
        SET msg = LEFT(CONCAT('Geometria vazia nao e permitida para ', NEW.nome), 255);
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
    END IF;
END $$

DROP TRIGGER IF EXISTS trg_area_protegida_bu $$
CREATE TRIGGER trg_area_protegida_bu BEFORE UPDATE ON area_protegida
FOR EACH ROW
BEGIN
    DECLARE msg VARCHAR(255);
    IF NOT (ST_AsWKB(NEW.geom) <=> ST_AsWKB(OLD.geom)) THEN
        IF NOT ST_IsValid(NEW.geom) THEN
            SET msg = LEFT(CONCAT('Geometria invalida para a area protegida ', NEW.nome), 255);
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
        END IF;
        IF ST_IsEmpty(NEW.geom) THEN
            SET msg = LEFT(CONCAT('Geometria vazia nao e permitida para ', NEW.nome), 255);
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
        END IF;
    END IF;
END $$

DROP TRIGGER IF EXISTS trg_area_protegida_ai $$
CREATE TRIGGER trg_area_protegida_ai AFTER INSERT ON area_protegida
FOR EACH ROW
BEGIN
    INSERT INTO log_auditoria (tabela, operacao, registro_id, dados_anteriores, dados_novos)
    VALUES ('area_protegida', 'INSERT', NEW.id, NULL, JSON_OBJECT(
        'id', NEW.id, 'nome', NEW.nome, 'categoria_uc', NEW.categoria_uc,
        'esfera', NEW.esfera, 'bioma_id', NEW.bioma_id, 'area_ha', NEW.area_ha,
        'geom_md5', MD5(ST_AsWKB(NEW.geom)),
        'criado_em', NEW.criado_em, 'atualizado_em', NEW.atualizado_em));

    INSERT INTO ocorrencia_area (ocorrencia_id, area_id)
    SELECT o.id, NEW.id
    FROM ocorrencia o
    WHERE ST_Contains(NEW.geom, o.geom);
END $$

DROP TRIGGER IF EXISTS trg_area_protegida_au $$
CREATE TRIGGER trg_area_protegida_au AFTER UPDATE ON area_protegida
FOR EACH ROW
BEGIN
    INSERT INTO log_auditoria (tabela, operacao, registro_id, dados_anteriores, dados_novos)
    VALUES ('area_protegida', 'UPDATE', NEW.id,
        JSON_OBJECT(
            'id', OLD.id, 'nome', OLD.nome, 'categoria_uc', OLD.categoria_uc,
            'esfera', OLD.esfera, 'bioma_id', OLD.bioma_id, 'area_ha', OLD.area_ha,
            'geom_md5', MD5(ST_AsWKB(OLD.geom)),
            'criado_em', OLD.criado_em, 'atualizado_em', OLD.atualizado_em),
        JSON_OBJECT(
            'id', NEW.id, 'nome', NEW.nome, 'categoria_uc', NEW.categoria_uc,
            'esfera', NEW.esfera, 'bioma_id', NEW.bioma_id, 'area_ha', NEW.area_ha,
            'geom_md5', MD5(ST_AsWKB(NEW.geom)),
            'criado_em', NEW.criado_em, 'atualizado_em', NEW.atualizado_em));

    IF NOT (ST_AsWKB(NEW.geom) <=> ST_AsWKB(OLD.geom)) THEN
        DELETE FROM ocorrencia_area WHERE area_id = NEW.id;
        INSERT INTO ocorrencia_area (ocorrencia_id, area_id)
        SELECT o.id, NEW.id
        FROM ocorrencia o
        WHERE ST_Contains(NEW.geom, o.geom);
    END IF;
END $$

DROP TRIGGER IF EXISTS trg_area_protegida_ad $$
CREATE TRIGGER trg_area_protegida_ad AFTER DELETE ON area_protegida
FOR EACH ROW
BEGIN
    INSERT INTO log_auditoria (tabela, operacao, registro_id, dados_anteriores, dados_novos)
    VALUES ('area_protegida', 'DELETE', OLD.id, JSON_OBJECT(
        'id', OLD.id, 'nome', OLD.nome, 'categoria_uc', OLD.categoria_uc,
        'esfera', OLD.esfera, 'bioma_id', OLD.bioma_id, 'area_ha', OLD.area_ha,
        'geom_md5', MD5(ST_AsWKB(OLD.geom)),
        'criado_em', OLD.criado_em, 'atualizado_em', OLD.atualizado_em), NULL);
END $$

-- ---------- Espécie: auditoria ----------
DROP TRIGGER IF EXISTS trg_especie_ai $$
CREATE TRIGGER trg_especie_ai AFTER INSERT ON especie
FOR EACH ROW
BEGIN
    INSERT INTO log_auditoria (tabela, operacao, registro_id, dados_anteriores, dados_novos)
    VALUES ('especie', 'INSERT', NEW.id, NULL, JSON_OBJECT(
        'id', NEW.id, 'nome_cientifico', NEW.nome_cientifico,
        'nome_popular', NEW.nome_popular, 'categoria_ameaca', NEW.categoria_ameaca,
        'categoria_fonte', NEW.categoria_fonte, 'genero_id', NEW.genero_id,
        'descricao', NEW.descricao, 'imagem_url', NEW.imagem_url, 'status', NEW.status,
        'criado_em', NEW.criado_em, 'atualizado_em', NEW.atualizado_em));
END $$

DROP TRIGGER IF EXISTS trg_especie_au $$
CREATE TRIGGER trg_especie_au AFTER UPDATE ON especie
FOR EACH ROW
BEGIN
    INSERT INTO log_auditoria (tabela, operacao, registro_id, dados_anteriores, dados_novos)
    VALUES ('especie', 'UPDATE', NEW.id,
        JSON_OBJECT(
            'id', OLD.id, 'nome_cientifico', OLD.nome_cientifico,
            'nome_popular', OLD.nome_popular, 'categoria_ameaca', OLD.categoria_ameaca,
            'categoria_fonte', OLD.categoria_fonte, 'genero_id', OLD.genero_id,
            'descricao', OLD.descricao, 'imagem_url', OLD.imagem_url, 'status', OLD.status,
            'criado_em', OLD.criado_em, 'atualizado_em', OLD.atualizado_em),
        JSON_OBJECT(
            'id', NEW.id, 'nome_cientifico', NEW.nome_cientifico,
            'nome_popular', NEW.nome_popular, 'categoria_ameaca', NEW.categoria_ameaca,
            'categoria_fonte', NEW.categoria_fonte, 'genero_id', NEW.genero_id,
            'descricao', NEW.descricao, 'imagem_url', NEW.imagem_url, 'status', NEW.status,
            'criado_em', NEW.criado_em, 'atualizado_em', NEW.atualizado_em));
END $$

DROP TRIGGER IF EXISTS trg_especie_ad $$
CREATE TRIGGER trg_especie_ad AFTER DELETE ON especie
FOR EACH ROW
BEGIN
    INSERT INTO log_auditoria (tabela, operacao, registro_id, dados_anteriores, dados_novos)
    VALUES ('especie', 'DELETE', OLD.id, JSON_OBJECT(
        'id', OLD.id, 'nome_cientifico', OLD.nome_cientifico,
        'nome_popular', OLD.nome_popular, 'categoria_ameaca', OLD.categoria_ameaca,
        'categoria_fonte', OLD.categoria_fonte, 'genero_id', OLD.genero_id,
        'descricao', OLD.descricao, 'imagem_url', OLD.imagem_url, 'status', OLD.status,
        'criado_em', OLD.criado_em, 'atualizado_em', OLD.atualizado_em), NULL);
END $$

DELIMITER ;

-- ---------- Dados de referência (rótulos em português claro) ----------
INSERT INTO categoria_ameaca (codigo, nome, descricao, ordem_prioridade) VALUES
    ('CR', 'Criticamente em Perigo',           'Risco altíssimo de extinção na natureza.',          1),
    ('EN', 'Entrando em Extinção',             'População entrando em processo de extinção.',        2),
    ('VU', 'Alto Risco de Entrar em Extinção', 'Alto risco de entrar em extinção na natureza.',      3),
    ('NT', 'Em Ameaça',                        'Espécie sob ameaça, próxima de risco elevado.',      4),
    ('LC', 'Sem Risco',                        'Ampla distribuição, população estável.',             5),
    ('DD', 'Sem Dados para Avaliar',           'Informação insuficiente para avaliar o risco.',      6),
    ('NE', 'Não Avaliada',                     'Espécie não avaliada para risco de extinção.',       7)
AS novo
ON DUPLICATE KEY UPDATE codigo = novo.codigo;

INSERT INTO bioma (id, nome, descricao) VALUES
    (1, 'Amazônia',      'Maior floresta tropical do mundo.'),
    (2, 'Mata Atlântica','Floresta tropical costeira, altamente fragmentada.'),
    (3, 'Cerrado',       'Savana tropical, hotspot de biodiversidade.'),
    (4, 'Caatinga',      'Vegetação semiárida exclusiva do Brasil.'),
    (5, 'Pampa',         'Campos subtropicais do sul.'),
    (6, 'Pantanal',      'Maior planície alagável do mundo.'),
    (7, 'Marinho',       'Ambientes marinhos brasileiros.')
AS novo
ON DUPLICATE KEY UPDATE id = novo.id;

INSERT INTO estado (uf, nome, regiao) VALUES
    ('AC','Acre','Norte'),('AP','Amapá','Norte'),('AM','Amazonas','Norte'),
    ('PA','Pará','Norte'),('RO','Rondônia','Norte'),('RR','Roraima','Norte'),
    ('TO','Tocantins','Norte'),
    ('AL','Alagoas','Nordeste'),('BA','Bahia','Nordeste'),('CE','Ceará','Nordeste'),
    ('MA','Maranhão','Nordeste'),('PB','Paraíba','Nordeste'),('PE','Pernambuco','Nordeste'),
    ('PI','Piauí','Nordeste'),('RN','Rio Grande do Norte','Nordeste'),('SE','Sergipe','Nordeste'),
    ('DF','Distrito Federal','Centro-Oeste'),('GO','Goiás','Centro-Oeste'),
    ('MT','Mato Grosso','Centro-Oeste'),('MS','Mato Grosso do Sul','Centro-Oeste'),
    ('ES','Espírito Santo','Sudeste'),('MG','Minas Gerais','Sudeste'),
    ('RJ','Rio de Janeiro','Sudeste'),('SP','São Paulo','Sudeste'),
    ('PR','Paraná','Sul'),('RS','Rio Grande do Sul','Sul'),('SC','Santa Catarina','Sul')
AS novo
ON DUPLICATE KEY UPDATE uf = novo.uf;

-- ---------- Final ----------
CALL refresh_dashboard();
