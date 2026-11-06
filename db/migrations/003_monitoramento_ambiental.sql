-- Monitoramento ambiental: focos de calor do INPE e alertas do DETER.
-- Cada tabela usa IF NOT EXISTS e os dados de referência são upsertados para
-- permitir repetir a migration se o MySQL interromper o DDL no meio.

CREATE TABLE IF NOT EXISTS monitor_fonte (
    id                    SMALLINT     NOT NULL AUTO_INCREMENT PRIMARY KEY,
    codigo                VARCHAR(80)  NOT NULL UNIQUE,
    nome                  VARCHAR(160) NOT NULL,
    orgao                 VARCHAR(120) NOT NULL,
    produto               VARCHAR(160) NOT NULL,
    formato               ENUM('csv','wfs') NOT NULL,
    endpoint              TEXT         NOT NULL,
    camada_wfs            VARCHAR(160),
    crs_origem            VARCHAR(16),
    frequencia_minutos    SMALLINT UNSIGNED,
    orientacao_atribuicao TEXT,
    ativo                 BOOLEAN      NOT NULL DEFAULT TRUE,
    criado_em             DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                           ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT monitor_fonte_frequencia_chk
        CHECK (frequencia_minutos IS NULL OR frequencia_minutos > 0)
);

CREATE TABLE IF NOT EXISTS monitor_tipo_evento (
    codigo     VARCHAR(32)  NOT NULL PRIMARY KEY,
    nome       VARCHAR(100) NOT NULL UNIQUE,
    descricao  TEXT,
    ativo      BOOLEAN      NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS monitor_execucao (
    id                BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    fonte_id          SMALLINT     NOT NULL,
    status            ENUM('em_execucao','concluida','parcial','erro')
                                   NOT NULL DEFAULT 'em_execucao',
    iniciada_em       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    concluida_em      DATETIME(6),
    janela_inicio     DATETIME(6),
    janela_fim        DATETIME(6),
    registros_lidos   INT UNSIGNED NOT NULL DEFAULT 0,
    registros_novos   INT UNSIGNED NOT NULL DEFAULT 0,
    registros_atualizados INT UNSIGNED NOT NULL DEFAULT 0,
    registros_ignorados   INT UNSIGNED NOT NULL DEFAULT 0,
    registros_rejeitados  INT UNSIGNED NOT NULL DEFAULT 0,
    parametros        JSON,
    checksum_arquivo  CHAR(64),
    erro              TEXT,
    UNIQUE KEY monitor_execucao_id_fonte_uq (id, fonte_id),
    KEY idx_monitor_execucao_fonte_data (fonte_id, iniciada_em DESC),
    KEY idx_monitor_execucao_status_data (status, iniciada_em DESC),
    CONSTRAINT monitor_execucao_fonte_fk
        FOREIGN KEY (fonte_id) REFERENCES monitor_fonte(id) ON DELETE RESTRICT,
    CONSTRAINT monitor_execucao_janela_chk
        CHECK (janela_inicio IS NULL OR janela_fim IS NULL OR janela_inicio <= janela_fim)
);

CREATE TABLE IF NOT EXISTS monitor_evento (
    id                       BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
    fonte_id                 SMALLINT      NOT NULL,
    ultima_execucao_id       BIGINT        NOT NULL,
    tipo_evento_codigo       VARCHAR(32)   NOT NULL,
    id_externo               VARCHAR(255)  NOT NULL,
    geom                     GEOMETRY      NOT NULL SRID 4326,
    data_observacao          DATETIME(6),
    precisao_data            ENUM('instante','dia','desconhecida')
                                             NOT NULL DEFAULT 'desconhecida',
    bioma_id                 SMALLINT,
    estado_uf                CHAR(2),
    municipio_nome           VARCHAR(120),
    municipio_codigo_ibge    CHAR(7),
    satelite                 VARCHAR(80),
    risco_fogo               DECIMAL(10,5),
    frp_mw                   DECIMAL(12,4),
    classe_fonte             VARCHAR(100),
    area_alerta_ha           DECIMAL(15,4),
    propriedades_origem      JSON,
    primeira_importacao_em   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    ultima_vista_em          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                            ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY monitor_evento_fonte_externo_uq (fonte_id, id_externo),
    KEY idx_monitor_evento_tipo_data (tipo_evento_codigo, data_observacao),
    KEY idx_monitor_evento_bioma_data (bioma_id, data_observacao),
    KEY idx_monitor_evento_estado_data (estado_uf, data_observacao),
    SPATIAL KEY idx_monitor_evento_geom (geom),
    CONSTRAINT monitor_evento_fonte_fk
        FOREIGN KEY (fonte_id) REFERENCES monitor_fonte(id) ON DELETE RESTRICT,
    CONSTRAINT monitor_evento_execucao_fonte_fk
        FOREIGN KEY (ultima_execucao_id, fonte_id)
        REFERENCES monitor_execucao(id, fonte_id) ON DELETE RESTRICT,
    CONSTRAINT monitor_evento_tipo_fk
        FOREIGN KEY (tipo_evento_codigo)
        REFERENCES monitor_tipo_evento(codigo) ON DELETE RESTRICT,
    CONSTRAINT monitor_evento_bioma_fk
        FOREIGN KEY (bioma_id) REFERENCES bioma(id) ON DELETE SET NULL,
    CONSTRAINT monitor_evento_estado_fk
        FOREIGN KEY (estado_uf) REFERENCES estado(uf) ON DELETE SET NULL,
    CONSTRAINT monitor_evento_risco_chk
        CHECK (risco_fogo IS NULL OR risco_fogo >= 0),
    CONSTRAINT monitor_evento_frp_chk
        CHECK (frp_mw IS NULL OR frp_mw >= 0),
    CONSTRAINT monitor_evento_area_chk
        CHECK (area_alerta_ha IS NULL OR area_alerta_ha >= 0)
);

CREATE TABLE IF NOT EXISTS monitor_prioridade (
    evento_id              BIGINT       NOT NULL PRIMARY KEY,
    versao_algoritmo       VARCHAR(40)  NOT NULL,
    score_risco            DECIMAL(5,2),
    score_recencia         DECIMAL(5,2),
    score_sensibilidade    DECIMAL(5,2),
    score_final            DECIMAL(5,2) NOT NULL,
    nivel                  ENUM('baixa','media','alta','critica') NOT NULL,
    calculado_em           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    KEY idx_monitor_prioridade_nivel_score (nivel, score_final DESC),
    CONSTRAINT monitor_prioridade_evento_fk
        FOREIGN KEY (evento_id) REFERENCES monitor_evento(id) ON DELETE CASCADE,
    CONSTRAINT monitor_prioridade_risco_chk
        CHECK (score_risco IS NULL OR score_risco BETWEEN 0 AND 100),
    CONSTRAINT monitor_prioridade_recencia_chk
        CHECK (score_recencia IS NULL OR score_recencia BETWEEN 0 AND 100),
    CONSTRAINT monitor_prioridade_sensibilidade_chk
        CHECK (score_sensibilidade IS NULL OR score_sensibilidade BETWEEN 0 AND 100),
    CONSTRAINT monitor_prioridade_final_chk
        CHECK (score_final BETWEEN 0 AND 100)
);

CREATE TABLE IF NOT EXISTS monitor_atendimento (
    evento_id          BIGINT       NOT NULL PRIMARY KEY,
    status             ENUM('novo','em_andamento','resolvido')
                                    NOT NULL DEFAULT 'novo',
    responsavel        VARCHAR(120),
    criado_em          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    iniciado_em        DATETIME(6),
    resolvido_em       DATETIME(6),
    atualizado_em      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                        ON UPDATE CURRENT_TIMESTAMP(6),
    KEY idx_monitor_atendimento_status_data (status, atualizado_em DESC),
    CONSTRAINT monitor_atendimento_evento_fk
        FOREIGN KEY (evento_id) REFERENCES monitor_evento(id) ON DELETE CASCADE,
    CONSTRAINT monitor_atendimento_datas_chk
        CHECK (resolvido_em IS NULL OR iniciado_em IS NULL OR resolvido_em >= iniciado_em)
);

CREATE TABLE IF NOT EXISTS monitor_atendimento_historico (
    id                 BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    evento_id          BIGINT       NOT NULL,
    status_anterior    ENUM('novo','em_andamento','resolvido'),
    status_novo        ENUM('novo','em_andamento','resolvido') NOT NULL,
    alterado_em        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    ator               VARCHAR(120) NOT NULL DEFAULT 'sistema',
    observacao         TEXT,
    KEY idx_monitor_atendimento_hist_evento_data (evento_id, alterado_em DESC),
    CONSTRAINT monitor_atendimento_hist_evento_fk
        FOREIGN KEY (evento_id) REFERENCES monitor_evento(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS monitor_evento_uc (
    evento_id          BIGINT       NOT NULL,
    area_id            INT          NOT NULL,
    tipo_relacao       ENUM('contem_ponto','intersecta_poligono') NOT NULL,
    intersecao_ha      DECIMAL(15,4),
    calculado_em       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (evento_id, area_id),
    KEY idx_monitor_evento_uc_area (area_id),
    CONSTRAINT monitor_evento_uc_evento_fk
        FOREIGN KEY (evento_id) REFERENCES monitor_evento(id) ON DELETE CASCADE,
    CONSTRAINT monitor_evento_uc_area_fk
        FOREIGN KEY (area_id) REFERENCES area_protegida(id) ON DELETE CASCADE,
    CONSTRAINT monitor_evento_uc_intersecao_chk
        CHECK (intersecao_ha IS NULL OR intersecao_ha >= 0)
);

INSERT INTO monitor_tipo_evento (codigo, nome, descricao, ativo) VALUES
    ('foco_calor', 'Foco de calor', 'Detecção pontual de fogo ativo publicada pelo Programa Queimadas do INPE.', TRUE),
    ('alerta_deter', 'Alerta DETER', 'Alerta de alteração da cobertura vegetal publicado pelo sistema DETER.', TRUE)
ON DUPLICATE KEY UPDATE
    nome = VALUES(nome),
    descricao = VALUES(descricao),
    ativo = VALUES(ativo);

INSERT INTO monitor_fonte (
    codigo, nome, orgao, produto, formato, endpoint, camada_wfs,
    crs_origem, frequencia_minutos, orientacao_atribuicao, ativo
) VALUES
    (
        'inpe_queimadas_diario_br',
        'Focos de calor diários - Brasil',
        'INPE',
        'Programa Queimadas - focos diários',
        'csv',
        'https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/focos_diario_br_{yyyymmdd}.csv',
        NULL,
        'EPSG:4326',
        1440,
        'Atribuir ao INPE / Programa Queimadas conforme a orientação oficial de citação.',
        TRUE
    ),
    (
        'terrabrasilis_deter_wfs',
        'Alertas DETER via WFS',
        'INPE',
        'TerraBrasilis - DETER',
        'wfs',
        'https://terrabrasilis.dpi.inpe.br/geoserver/ows',
        NULL,
        NULL,
        1440,
        'Atribuir ao INPE / TerraBrasilis e validar os termos e a camada antes de ativar.',
        FALSE
    )
ON DUPLICATE KEY UPDATE
    nome = VALUES(nome),
    orgao = VALUES(orgao),
    produto = VALUES(produto),
    formato = VALUES(formato),
    endpoint = VALUES(endpoint),
    frequencia_minutos = VALUES(frequencia_minutos),
    orientacao_atribuicao = VALUES(orientacao_atribuicao);
