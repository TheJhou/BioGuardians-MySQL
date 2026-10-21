-- ============================================================
-- BioGuardians - Smoke Tests (MySQL 8.4)
-- Validates that migrations applied correctly and that core
-- database features (spatial, triggers, refresh procedure) work.
-- Used by CI (GitHub Actions) and can be run manually.
--
-- These tests validate STRUCTURE, not data. Data is loaded
-- separately via the data loading scripts (MMA, CNUC, GBIF,
-- speciesLink) and is not expected in CI ephemeral databases.
--
-- Usage:
--   mysql --default-character-set=utf8mb4 -u <user> -p <database> < db/tests/smoke_test.sql
--
-- The mysql client stops at the first failed test (SIGNAL).
-- Test rows are created and removed inside each test.
--
-- ATENÇÃO: dentro de procedures do MySQL, uma variável local com o
-- mesmo nome de uma coluna vence a coluna ("WHERE genero_id = genero_id"
-- vira sempre verdadeiro e apagaria a tabela inteira). Todas as
-- variáveis locais usam o prefixo v_.
-- ============================================================

SELECT '==> Running BioGuardians smoke tests...' AS '';

DELIMITER $$

-- ---------- Test 1: All expected tables exist ----------
DROP PROCEDURE IF EXISTS smoke_1_tables $$
CREATE PROCEDURE smoke_1_tables()
BEGIN
    DECLARE v_missing TEXT;
    SELECT GROUP_CONCAT(t.name) INTO v_missing
    FROM JSON_TABLE(
        '["categoria_ameaca","bioma","estado","taxon","especie","especie_bioma",
          "especie_estado","area_protegida","ocorrencia","ocorrencia_area",
          "log_auditoria","deteccao","deteccao_job","imagem_job","modelo_ml",
          "area_tile","dashboard_stats","especies_por_uc",
          "ranking_especies_categoria","ucs_por_esfera","schema_migrations"]',
        '$[*]' COLUMNS (name VARCHAR(64) PATH '$')
    ) t
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.tables it
        WHERE it.table_schema = DATABASE() AND it.table_name = t.name
    );
    IF v_missing IS NOT NULL THEN
        SET v_missing = CONCAT('Test 1 failed - missing tables: ', v_missing);
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_missing;
    END IF;
END $$

-- ---------- Test 2: Reference data was loaded ----------
DROP PROCEDURE IF EXISTS smoke_2_reference $$
CREATE PROCEDURE smoke_2_reference()
BEGIN
    IF (SELECT COUNT(*) FROM categoria_ameaca) < 7 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Test 2 failed - categoria_ameaca not fully loaded (expected 7)';
    END IF;
    IF (SELECT COUNT(*) FROM bioma) < 7 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Test 2 failed - bioma not fully loaded (expected 7)';
    END IF;
    IF (SELECT COUNT(*) FROM estado) < 27 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Test 2 failed - estado not fully loaded (expected 27)';
    END IF;
    -- Accents must survive the client connection (latin1 would corrupt them).
    IF NOT EXISTS (SELECT 1 FROM estado WHERE uf = 'SP' AND nome = 'São Paulo') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Test 2 failed - accented reference data is corrupted (check utf8mb4)';
    END IF;
END $$

-- ---------- Test 3: Routines and triggers exist ----------
DROP PROCEDURE IF EXISTS smoke_3_routines $$
CREATE PROCEDURE smoke_3_routines()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.routines
        WHERE routine_schema = DATABASE() AND routine_name = 'refresh_dashboard'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Test 3 failed - procedure refresh_dashboard missing';
    END IF;
    IF (SELECT COUNT(*) FROM information_schema.triggers
        WHERE trigger_schema = DATABASE()) < 14 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Test 3 failed - expected 14 triggers';
    END IF;
END $$

-- ---------- Test 4: Dashboard refresh populates its tables ----------
DROP PROCEDURE IF EXISTS smoke_4_dashboard $$
CREATE PROCEDURE smoke_4_dashboard()
BEGIN
    CALL refresh_dashboard();
    IF (SELECT COUNT(*) FROM dashboard_stats) <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Test 4 failed - dashboard_stats should have exactly 1 row';
    END IF;
END $$

-- ---------- Test 5: Audit trigger fires on INSERT ----------
DROP PROCEDURE IF EXISTS smoke_5_audit $$
CREATE PROCEDURE smoke_5_audit()
BEGIN
    DECLARE v_genero_id INT;
    DECLARE v_especie_id INT;
    DECLARE v_before_count BIGINT;

    INSERT INTO taxon (nome, `rank`) VALUES ('testgenus_smoke', 'genero');
    SET v_genero_id = LAST_INSERT_ID();

    SELECT COUNT(*) INTO v_before_count FROM log_auditoria WHERE tabela = 'especie';

    INSERT INTO especie (nome_cientifico, nome_popular, categoria_ameaca, genero_id)
    VALUES ('testus smokeus', 'test species', 'LC', v_genero_id);
    SET v_especie_id = LAST_INSERT_ID();

    IF (SELECT COUNT(*) FROM log_auditoria WHERE tabela = 'especie') <= v_before_count THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Test 5 failed - audit trigger did not fire on INSERT into especie';
    END IF;

    DELETE FROM especie WHERE id = v_especie_id;
    DELETE FROM taxon WHERE id = v_genero_id;
    DELETE FROM log_auditoria WHERE tabela = 'especie' AND registro_id = v_especie_id;
END $$

-- ---------- Test 6: Scientific name format is enforced ----------
DROP PROCEDURE IF EXISTS smoke_6_nome_cientifico $$
CREATE PROCEDURE smoke_6_nome_cientifico()
BEGIN
    DECLARE v_genero_id INT;
    DECLARE v_rejected BOOLEAN DEFAULT FALSE;

    INSERT INTO taxon (nome, `rank`) VALUES ('testgenus_smoke', 'genero');
    SET v_genero_id = LAST_INSERT_ID();

    BEGIN
        DECLARE CONTINUE HANDLER FOR 3819 SET v_rejected = TRUE;  -- check constraint violated
        INSERT INTO especie (nome_cientifico, categoria_ameaca, genero_id)
        VALUES ('Testus Uppercase', 'LC', v_genero_id);
    END;

    -- Only reached if the bad row was accepted: remove it and its audit entry.
    DELETE FROM log_auditoria WHERE tabela = 'especie' AND registro_id IN (
        SELECT id FROM especie WHERE genero_id = v_genero_id);
    DELETE FROM especie WHERE genero_id = v_genero_id;
    DELETE FROM taxon WHERE id = v_genero_id;

    IF NOT v_rejected THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Test 6 failed - uppercase nome_cientifico was accepted';
    END IF;
END $$

-- ---------- Test 7: Geometry validation trigger ----------
DROP PROCEDURE IF EXISTS smoke_7_geometry $$
CREATE PROCEDURE smoke_7_geometry()
BEGIN
    DECLARE v_valid_id INT;
    DECLARE v_rejected BOOLEAN DEFAULT FALSE;

    -- Valid geometry must be accepted
    INSERT INTO area_protegida (nome, categoria_uc, esfera, geom)
    VALUES ('TEST-AREA-VALID', 'protecao_integral', 'federal',
        ST_GeomFromGeoJSON('{"type":"MultiPolygon","coordinates":[[[[0,0],[0.1,0],[0.1,0.1],[0,0.1],[0,0]]]]}'));
    SET v_valid_id = LAST_INSERT_ID();
    DELETE FROM area_protegida WHERE id = v_valid_id;
    DELETE FROM log_auditoria WHERE tabela = 'area_protegida' AND registro_id = v_valid_id;

    -- Self-intersecting polygon (bowtie) must be rejected
    BEGIN
        DECLARE CONTINUE HANDLER FOR SQLSTATE '45000' SET v_rejected = TRUE;
        INSERT INTO area_protegida (nome, categoria_uc, esfera, geom)
        VALUES ('TEST-AREA-INVALID', 'protecao_integral', 'federal',
            ST_GeomFromGeoJSON('{"type":"MultiPolygon","coordinates":[[[[0,0],[1,1],[0,1],[1,0],[0,0]]]]}'));
    END;

    IF NOT v_rejected THEN
        DELETE FROM log_auditoria WHERE tabela = 'area_protegida' AND registro_id IN (
            SELECT id FROM area_protegida WHERE nome = 'TEST-AREA-INVALID');
        DELETE FROM area_protegida WHERE nome = 'TEST-AREA-INVALID';
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Test 7 failed - invalid geometry was accepted';
    END IF;
END $$

-- ---------- Test 8: lat/lon -> geom (axis order) and ocorrencia_area ----------
DROP PROCEDURE IF EXISTS smoke_8_spatial $$
CREATE PROCEDURE smoke_8_spatial()
BEGIN
    DECLARE v_genero_id INT;
    DECLARE v_especie_id INT;
    DECLARE v_area_id INT;
    DECLARE v_dentro_id INT;
    DECLARE v_fora_id INT;
    DECLARE v_failure VARCHAR(255) DEFAULT NULL;

    INSERT INTO taxon (nome, `rank`) VALUES ('testgenus_smoke', 'genero');
    SET v_genero_id = LAST_INSERT_ID();
    INSERT INTO especie (nome_cientifico, categoria_ameaca, genero_id)
    VALUES ('testus spatialis', 'CR', v_genero_id);
    SET v_especie_id = LAST_INSERT_ID();

    -- UC around Brasília (lon -48..-47, lat -16..-15)
    INSERT INTO area_protegida (nome, categoria_uc, esfera, geom)
    VALUES ('TEST-AREA-SPATIAL', 'protecao_integral', 'federal',
        ST_GeomFromGeoJSON('{"type":"MultiPolygon","coordinates":[[[[-48,-16],[-47,-16],[-47,-15],[-48,-15],[-48,-16]]]]}'));
    SET v_area_id = LAST_INSERT_ID();

    INSERT INTO ocorrencia (especie_id, lat, lon) VALUES (v_especie_id, -15.8, -47.9);
    SET v_dentro_id = LAST_INSERT_ID();
    -- Swapped axes (lat=-47.9, lon=-15.8) would fall outside the UC
    INSERT INTO ocorrencia (especie_id, lat, lon) VALUES (v_especie_id, -47.9, -15.8);
    SET v_fora_id = LAST_INSERT_ID();

    IF (SELECT ROUND(ST_Longitude(geom), 6) FROM ocorrencia WHERE id = v_dentro_id) <> -47.9
       OR (SELECT ROUND(ST_Latitude(geom), 6) FROM ocorrencia WHERE id = v_dentro_id) <> -15.8 THEN
        SET v_failure = 'Test 8 failed - geom does not match lat/lon (axis order)';
    ELSEIF NOT EXISTS (SELECT 1 FROM ocorrencia_area
                       WHERE ocorrencia_id = v_dentro_id AND area_id = v_area_id) THEN
        SET v_failure = 'Test 8 failed - ocorrencia inside the UC is missing from ocorrencia_area';
    ELSEIF EXISTS (SELECT 1 FROM ocorrencia_area WHERE ocorrencia_id = v_fora_id) THEN
        SET v_failure = 'Test 8 failed - ocorrencia outside the UC was linked to it';
    END IF;

    -- Moving the point out of the UC must unlink it
    IF v_failure IS NULL THEN
        UPDATE ocorrencia SET lat = 10, lon = 10 WHERE id = v_dentro_id;
        IF EXISTS (SELECT 1 FROM ocorrencia_area WHERE ocorrencia_id = v_dentro_id) THEN
            SET v_failure = 'Test 8 failed - ocorrencia_area not updated after moving the point';
        END IF;
    END IF;

    -- ocorrencia and ocorrencia_area rows go away by cascade.
    DELETE FROM area_protegida WHERE id = v_area_id;
    DELETE FROM especie WHERE id = v_especie_id;
    DELETE FROM taxon WHERE id = v_genero_id;
    DELETE FROM log_auditoria
        WHERE (tabela = 'area_protegida' AND registro_id = v_area_id)
           OR (tabela = 'especie' AND registro_id = v_especie_id);

    IF v_failure IS NOT NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_failure;
    END IF;
END $$

-- ---------- Test 9: Migration journal ----------
DROP PROCEDURE IF EXISTS smoke_9_journal $$
CREATE PROCEDURE smoke_9_journal()
BEGIN
    IF (SELECT COUNT(*) FROM schema_migrations) < 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Test 9 failed - schema_migrations is empty';
    END IF;
END $$

DELIMITER ;

SELECT 'Test 1: tables' AS '';               CALL smoke_1_tables();
SELECT 'Test 2: reference data' AS '';       CALL smoke_2_reference();
SELECT 'Test 3: routines/triggers' AS '';    CALL smoke_3_routines();
SELECT 'Test 4: dashboard refresh' AS '';    CALL smoke_4_dashboard();
SELECT 'Test 5: audit trigger' AS '';        CALL smoke_5_audit();
SELECT 'Test 6: nome_cientifico' AS '';      CALL smoke_6_nome_cientifico();
SELECT 'Test 7: geometry validation' AS '';  CALL smoke_7_geometry();
SELECT 'Test 8: spatial + axis order' AS ''; CALL smoke_8_spatial();
SELECT 'Test 9: migration journal' AS '';    CALL smoke_9_journal();

DROP PROCEDURE smoke_1_tables;
DROP PROCEDURE smoke_2_reference;
DROP PROCEDURE smoke_3_routines;
DROP PROCEDURE smoke_4_dashboard;
DROP PROCEDURE smoke_5_audit;
DROP PROCEDURE smoke_6_nome_cientifico;
DROP PROCEDURE smoke_7_geometry;
DROP PROCEDURE smoke_8_spatial;
DROP PROCEDURE smoke_9_journal;

SELECT '==> All smoke tests passed!' AS '';
