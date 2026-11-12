import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type {
  MonitorEventCollection,
  MonitorEventDetail,
  MonitorEventFeature,
  MonitorSource,
  MonitorSummary,
  MonitorStatus,
} from '../types/index.js';

const STATUS_LABELS: Record<string, string> = {
  novo: 'Novo',
  em_andamento: 'Em andamento',
  resolvido: 'Resolvido',
  sem_classificacao: 'Sem status',
};

function formatDate(value: string | null): string {
  if (!value) return 'Data não informada';
  const parsed = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('pt-BR');
}

function formatCount(value: number): string {
  return value.toLocaleString('pt-BR');
}

function statusClass(status: string | null): string {
  return status ? `monitor-status monitor-status--${status}` : 'monitor-status monitor-status--unknown';
}

function EventCard({ event, onOpen }: { event: MonitorEventFeature; onOpen: (id: number) => void }) {
  const { properties } = event;
  return (
    <article className="monitor-event-card">
      <div className="monitor-event-topline">
        <span className="monitor-event-type">
          {properties.tipo === 'foco_calor' ? 'Foco de calor' : 'Alerta ambiental'}
        </span>
        <span className={statusClass(properties.status_atendimento)}>
          {STATUS_LABELS[properties.status_atendimento ?? ''] ?? 'Sem status'}
        </span>
      </div>
      <h2>{properties.municipio || properties.estado_uf || properties.bioma || properties.fonte_nome}</h2>
      <p className="monitor-event-location">
        {[properties.municipio, properties.estado_uf, properties.bioma].filter(Boolean).join(' · ') || 'Localização sem referência administrativa'}
      </p>
      <dl className="monitor-event-facts">
        <div><dt>Observado</dt><dd>{formatDate(properties.data_observacao)}</dd></div>
        <div><dt>Fonte</dt><dd>{properties.fonte_nome}</dd></div>
        <div><dt>Satélite</dt><dd>{properties.satelite || '—'}</dd></div>
        <div><dt>FRP</dt><dd>{properties.frp_mw === null ? '—' : `${properties.frp_mw} MW`}</dd></div>
        <div><dt>Risco de fogo</dt><dd>{properties.risco_fogo ?? '—'}</dd></div>
        <div><dt>Prioridade</dt><dd>{properties.prioridade ? STATUS_LABELS[properties.prioridade] ?? properties.prioridade : 'Não calculada'}</dd></div>
      </dl>
      <button className="monitor-detail-button" type="button" onClick={() => onOpen(event.id)}>
        Ver detalhes
      </button>
    </article>
  );
}

function EventDetails({ detail, onClose }: { detail: MonitorEventDetail; onClose: () => void }) {
  const coordinates = detail.geometry?.type === 'Point' && Array.isArray(detail.geometry.coordinates)
    ? detail.geometry.coordinates as number[]
    : null;

  return (
    <section className="monitor-detail-panel" aria-label="Detalhes do alerta">
      <div className="monitor-detail-heading">
        <div>
          <p className="monitor-eyebrow">Detalhes do evento</p>
          <h2>{detail.properties.municipio || detail.properties.fonte_nome}</h2>
        </div>
        <button type="button" className="monitor-close-button" onClick={onClose} aria-label="Fechar detalhes">×</button>
      </div>
      <div className="monitor-detail-grid">
        <div><span>Status</span><strong>{STATUS_LABELS[detail.atendimento.status ?? ''] ?? 'Sem status'}</strong></div>
        <div><span>Fonte</span><strong>{detail.properties.fonte_nome}</strong></div>
        <div><span>Data</span><strong>{formatDate(detail.properties.data_observacao)}</strong></div>
        <div><span>Bioma</span><strong>{detail.properties.bioma || 'Não informado'}</strong></div>
        <div><span>Classe da fonte</span><strong>{detail.properties.classe_fonte || 'Não se aplica'}</strong></div>
        <div><span>Área do alerta</span><strong>{detail.properties.area_alerta_ha === null ? '—' : `${detail.properties.area_alerta_ha} ha`}</strong></div>
        <div><span>Coordenadas</span><strong>{coordinates ? `${coordinates[1]}, ${coordinates[0]}` : 'Geometria disponível no mapa'}</strong></div>
        <div><span>Última atualização</span><strong>{formatDate(detail.properties.atualizado_em ?? null)}</strong></div>
      </div>
      {detail.unidades_conservacao.length > 0 && (
        <div className="monitor-detail-section">
          <h3>Unidades de Conservação relacionadas</h3>
          <ul>{detail.unidades_conservacao.map((area) => <li key={area.id}>{area.nome}</li>)}</ul>
        </div>
      )}
      <div className="monitor-detail-section">
        <h3>Histórico de atendimento</h3>
        {detail.historico_atendimento.length === 0
          ? <p>Sem registros no histórico.</p>
          : <ol>{detail.historico_atendimento.map((entry, index) => (
            <li key={`${entry.alterado_em}-${index}`}>
              <strong>{STATUS_LABELS[entry.status_novo] ?? entry.status_novo}</strong>
              <span>{formatDate(entry.alterado_em)} · {entry.ator}</span>
            </li>
          ))}</ol>}
      </div>
      <p className="monitor-readonly-note">Esta consulta exibe os dados recebidos; o status não é editado por esta tela.</p>
    </section>
  );
}

export default function MonitoramentoPage() {
  const [sourceFilter, setSourceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<MonitorStatus | ''>('');
  const [page, setPage] = useState(1);
  const [events, setEvents] = useState<MonitorEventCollection | null>(null);
  const [summary, setSummary] = useState<MonitorSummary | null>(null);
  const [sources, setSources] = useState<MonitorSource[]>([]);
  const [selected, setSelected] = useState<MonitorEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');

  // Fontes e KPIs não dependem dos filtros nem da página: uma chamada só, na
  // montagem. O resumo vem pré-calculado da última importação (monitor_resumo).
  useEffect(() => {
    api.getMonitoramentoFontes().then((result) => setSources(result.data)).catch(() => setSources([]));
    api.getMonitoramentoResumo().then(setSummary).catch(() => setSummary(null));
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api.getMonitoramentoEventos({ fonte: sourceFilter || undefined, status: statusFilter || undefined, page, per_page: 20 })
      .then((eventResult) => {
        if (active) setEvents(eventResult);
      }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : 'Não foi possível carregar os alertas.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sourceFilter, statusFilter, page]);

  const openDetails = async (id: number) => {
    setDetailLoading(true);
    setSelected(null);
    try {
      setSelected(await api.getMonitoramentoEvento(id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível carregar os detalhes.');
    } finally {
      setDetailLoading(false);
    }
  };

  const activeSources = sources.filter((source) => Boolean(source.ativo));

  return (
    <div className="monitoramento-page">
      <div className="monitoramento-shell">
        <header className="monitor-hero">
          <div>
            <p className="monitor-eyebrow">Dados ambientais</p>
            <h1>Monitoramento</h1>
            <p>Focos de calor e alertas ambientais publicados pelas fontes oficiais.</p>
          </div>
          <span className="monitor-source-count">{activeSources.length} {activeSources.length === 1 ? 'fonte ativa' : 'fontes ativas'}</span>
        </header>

        <section className="monitor-summary" aria-label="Resumo dos eventos">
          <div className="monitor-summary-total"><span>Eventos carregados</span><strong>{summary ? formatCount(summary.total) : '—'}</strong></div>
          {(['novo', 'em_andamento', 'resolvido'] as const).map((status) => (
            <div className="monitor-summary-status" key={status}>
              <span>{STATUS_LABELS[status]}</span><strong>{formatCount(summary?.por_status[status] ?? 0)}</strong>
            </div>
          ))}
        </section>

        <section className="monitor-controls" aria-label="Filtros dos eventos">
          <label>
            Fonte
            <select value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value); setPage(1); setSelected(null); }}>
              <option value="">Todas as fontes</option>
              {sources.map((source) => <option key={source.codigo} value={source.codigo}>{source.nome}{source.ativo ? '' : ' (inativa)'}</option>)}
            </select>
          </label>
          <label>
            Atendimento
            <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as MonitorStatus | ''); setPage(1); setSelected(null); }}>
              <option value="">Todos</option>
              <option value="novo">Novo</option>
              <option value="em_andamento">Em andamento</option>
              <option value="resolvido">Resolvido</option>
            </select>
          </label>
          <span className="monitor-latest-run">
            Atualização mais recente: {formatDate(sources.map((source) => source.concluida_em).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null)}
          </span>
        </section>

        {error && <p className="monitor-error" role="alert">{error}</p>}
        {detailLoading && <p className="monitor-loading">Carregando detalhes…</p>}
        {selected && <EventDetails detail={selected} onClose={() => setSelected(null)} />}

        <section className="monitor-events" aria-label="Lista de eventos">
          {loading ? <p className="monitor-loading">Carregando eventos…</p>
            : events?.features.length ? events.features.map((event) => (
              <EventCard key={event.id} event={event} onOpen={openDetails} />
            ))
              : <div className="monitor-empty"><h2>Nenhum evento encontrado</h2><p>As fontes ainda podem não ter concluído a primeira coleta.</p></div>}
        </section>

        {events && events.total_pages > 1 && (
          <nav className="monitor-pagination" aria-label="Paginação dos eventos">
            <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>Anterior</button>
            <span>Página {events.page} de {events.total_pages} · {formatCount(events.total)}{events.total_limitado ? '+' : ''} eventos</span>
            <button type="button" disabled={page >= events.total_pages || loading} onClick={() => setPage((value) => value + 1)}>Próxima</button>
          </nav>
        )}
      </div>
    </div>
  );
}
