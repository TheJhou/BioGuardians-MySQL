-- TerraBrasilis public DETER WFS layers confirmed on 2026-11-06.
-- These layers expose weekly delayed public data; the daily early feed requires
-- restricted credentials and is intentionally not used by this integration.

UPDATE monitor_fonte
SET codigo = 'terrabrasilis_deter_amazonia_wfs',
    nome = 'Avisos DETER Amazônia - floresta (TerraBrasilis WFS)',
    orgao = 'INPE',
    produto = 'TerraBrasilis - DETER Amazônia floresta',
    formato = 'wfs',
    endpoint = 'https://terrabrasilis.dpi.inpe.br/geoserver/deter-amz/wfs',
    camada_wfs = 'deter-amz:deter_amz',
    crs_origem = 'EPSG:4674',
    frequencia_minutos = 1440,
    orientacao_atribuicao = 'Fonte: INPE/TerraBrasilis, DETER Amazônia. Camada pública com atraso aproximado de uma semana. Geometria transformada pelo GeoServer para EPSG:4326.',
    ativo = TRUE
WHERE codigo IN ('terrabrasilis_deter_wfs', 'terrabrasilis_deter_amazonia_wfs');

INSERT INTO monitor_fonte (
    codigo, nome, orgao, produto, formato, endpoint, camada_wfs,
    crs_origem, frequencia_minutos, orientacao_atribuicao, ativo
) VALUES (
    'terrabrasilis_deter_cerrado_wfs',
    'Avisos DETER Cerrado (TerraBrasilis WFS)',
    'INPE',
    'TerraBrasilis - DETER Cerrado',
    'wfs',
    'https://terrabrasilis.dpi.inpe.br/geoserver/deter-cerrado-nb/wfs',
    'deter-cerrado-nb:deter_cerrado',
    'EPSG:4674',
    1440,
    'Fonte: INPE/TerraBrasilis, DETER Cerrado. Camada pública com atraso aproximado de uma semana. Geometria transformada pelo GeoServer para EPSG:4326.',
    TRUE
)
ON DUPLICATE KEY UPDATE
    nome = VALUES(nome),
    orgao = VALUES(orgao),
    produto = VALUES(produto),
    formato = VALUES(formato),
    endpoint = VALUES(endpoint),
    camada_wfs = VALUES(camada_wfs),
    crs_origem = VALUES(crs_origem),
    frequencia_minutos = VALUES(frequencia_minutos),
    orientacao_atribuicao = VALUES(orientacao_atribuicao),
    ativo = VALUES(ativo);
