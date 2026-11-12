-- Monitoramento: listagem e KPIs sem varrer monitor_evento a cada request.
--
-- Com ~700 mil focos, GET /monitoramento/eventos levava 5-13 s (ORDER BY por
-- data sem índice = filesort da tabela inteira) e GET /monitoramento/resumo
-- ~3 s (GROUP BY com quatro joins). Esta migration:
--   1. cria índices por data (geral e por fonte) para o ORDER BY ... LIMIT;
--   2. cria monitor_resumo, uma linha com os agregados que os cards de KPI
--      leem, recalculada por refresh_monitor_resumo() ao fim de cada importação
--      (finishExecution no backend) em vez de a cada acesso.
-- Idempotente: os índices só são criados se ainda não existirem.

DELIMITER $$

DROP PROCEDURE IF EXISTS _mig005_add_index $$
CREATE PROCEDURE _mig005_add_index(IN v_index VARCHAR(64), IN v_ddl TEXT)
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = 'monitor_evento'
          AND index_name = v_index
    ) THEN
        SET @mig005_ddl = v_ddl;
        PREPARE mig005_stmt FROM @mig005_ddl;
        EXECUTE mig005_stmt;
        DEALLOCATE PREPARE mig005_stmt;
    END IF;
END $$

DELIMITER ;

CALL _mig005_add_index('idx_monitor_evento_data',
    'ALTER TABLE monitor_evento ADD INDEX idx_monitor_evento_data (data_observacao, id)');
CALL _mig005_add_index('idx_monitor_evento_fonte_data',
    'ALTER TABLE monitor_evento ADD INDEX idx_monitor_evento_fonte_data (fonte_id, data_observacao, id)');
DROP PROCEDURE IF EXISTS _mig005_add_index;

CREATE TABLE IF NOT EXISTS monitor_resumo (
    id              TINYINT      NOT NULL PRIMARY KEY,
    total           BIGINT       NOT NULL,
    por_tipo        JSON         NOT NULL,
    por_status      JSON         NOT NULL,
    por_prioridade  JSON         NOT NULL,
    por_bioma       JSON         NOT NULL,
    atualizado_em   DATETIME(6)  NOT NULL,
    CONSTRAINT monitor_resumo_singleton_chk CHECK (id = 1)
);

DELIMITER $$

-- Recalcula a linha única de monitor_resumo. Mesmo formato do
-- GET /monitoramento/resumo sem filtros: eventos sem atendimento, prioridade
-- ou bioma contam em 'sem_classificacao'.
DROP PROCEDURE IF EXISTS refresh_monitor_resumo $$
CREATE PROCEDURE refresh_monitor_resumo()
BEGIN
    DECLARE v_total BIGINT;
    DECLARE v_com_status BIGINT;
    DECLARE v_com_prioridade BIGINT;
    DECLARE v_por_tipo JSON;
    DECLARE v_por_status JSON;
    DECLARE v_por_prioridade JSON;
    DECLARE v_por_bioma JSON;

    SELECT COUNT(*) INTO v_total FROM monitor_evento;

    SELECT COALESCE(JSON_OBJECTAGG(t.tipo, t.n), JSON_OBJECT()) INTO v_por_tipo
    FROM (SELECT tipo_evento_codigo AS tipo, COUNT(*) AS n
          FROM monitor_evento GROUP BY tipo_evento_codigo) t;

    SELECT COALESCE(JSON_OBJECTAGG(s.status, s.n), JSON_OBJECT()), COALESCE(SUM(s.n), 0)
      INTO v_por_status, v_com_status
    FROM (SELECT CAST(status AS CHAR) AS status, COUNT(*) AS n
          FROM monitor_atendimento GROUP BY status) s;
    IF v_total > v_com_status THEN
        SET v_por_status = JSON_SET(v_por_status, '$.sem_classificacao', v_total - v_com_status);
    END IF;

    SELECT COALESCE(JSON_OBJECTAGG(p.nivel, p.n), JSON_OBJECT()), COALESCE(SUM(p.n), 0)
      INTO v_por_prioridade, v_com_prioridade
    FROM (SELECT CAST(nivel AS CHAR) AS nivel, COUNT(*) AS n
          FROM monitor_prioridade GROUP BY nivel) p;
    IF v_total > v_com_prioridade THEN
        SET v_por_prioridade = JSON_SET(v_por_prioridade, '$.sem_classificacao', v_total - v_com_prioridade);
    END IF;

    SELECT COALESCE(JSON_OBJECTAGG(COALESCE(b.nome, 'sem_classificacao'), g.n), JSON_OBJECT())
      INTO v_por_bioma
    FROM (SELECT bioma_id, COUNT(*) AS n FROM monitor_evento GROUP BY bioma_id) g
    LEFT JOIN bioma b ON b.id = g.bioma_id;

    INSERT INTO monitor_resumo (id, total, por_tipo, por_status, por_prioridade, por_bioma, atualizado_em)
    VALUES (1, v_total, v_por_tipo, v_por_status, v_por_prioridade, v_por_bioma, UTC_TIMESTAMP(6))
    ON DUPLICATE KEY UPDATE
        total = VALUES(total),
        por_tipo = VALUES(por_tipo),
        por_status = VALUES(por_status),
        por_prioridade = VALUES(por_prioridade),
        por_bioma = VALUES(por_bioma),
        atualizado_em = VALUES(atualizado_em);
END $$

DELIMITER ;

CALL refresh_monitor_resumo();
