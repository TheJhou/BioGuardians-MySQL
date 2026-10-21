-- ============================================================
-- BioGuardians — 002: validação de geometria no plano
--
-- A 001 validava area_protegida.geom com ST_IsValid em SRID 4326, que no
-- MySQL usa o elipsoide e é mais rigoroso que o ST_IsValid do PostGIS
-- (planar, em geometry). Na cópia do backup de produção (2026-09-30),
-- 94 das 3.371 UCs — todas válidas no PostGIS — foram rejeitadas.
--
-- Agora a validação é feita no plano (ST_SRID(geom, 0): mesmas coordenadas
-- lon/lat, cálculo cartesiano), o mesmo critério do PostGIS. Isso aceita
-- 77 das 94. Em 18 UCs (as 17 restantes + 1 que só era válida no
-- elipsoide) o validador do MySQL (Boost) discorda do PostGIS (GEOS);
-- arredondar as coordenadas na origem resolve:
-- ST_MakeValid(ST_SnapToGrid(geom, 1e-7)) no PostGIS (~1 cm, variação de
-- área <= 0,0002% nessas UCs) antes de exportar. Com isso as 3.371 UCs
-- entram e ocorrencia_area fica idêntica à do PostgreSQL (1.738 ligações).
--
-- Só os triggers de validação mudam. DROP + CREATE = idempotente.
-- ============================================================

DELIMITER $$

DROP TRIGGER IF EXISTS trg_area_protegida_bi $$
CREATE TRIGGER trg_area_protegida_bi BEFORE INSERT ON area_protegida
FOR EACH ROW
BEGIN
    DECLARE msg VARCHAR(255);
    IF NOT ST_IsValid(ST_SRID(NEW.geom, 0)) THEN
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
        IF NOT ST_IsValid(ST_SRID(NEW.geom, 0)) THEN
            SET msg = LEFT(CONCAT('Geometria invalida para a area protegida ', NEW.nome), 255);
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
        END IF;
        IF ST_IsEmpty(NEW.geom) THEN
            SET msg = LEFT(CONCAT('Geometria vazia nao e permitida para ', NEW.nome), 255);
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
        END IF;
    END IF;
END $$

DELIMITER ;
