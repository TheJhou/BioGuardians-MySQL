// Custom application metrics beyond what auto-instrumentation provides.
// Uses OTel Metrics API — if SDK is not initialized, returns no-op instruments.

import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('bioguardians-backend', '1.0.0');

// --- Cache metrics ---
export const cacheHits = meter.createCounter('bioguardians_cache_hits_total', {
  description: 'Total number of cache hits',
  unit: '1',
});

export const cacheMisses = meter.createCounter('bioguardians_cache_misses_total', {
  description: 'Total number of cache misses',
  unit: '1',
});

// --- Database metrics ---
// A instrumentação do mysql2 só gera spans (a do pg gerava este histograma).
// Mesmo nome e label do dashboard do Grafana:
// db_client_operation_duration_seconds{db_operation="SELECT"}.
export const dbOperationDuration = meter.createHistogram('db.client.operation.duration', {
  description: 'Duration of database queries',
  unit: 's',
});

// --- Error metrics ---
export const errorCounter = meter.createCounter('bioguardians_errors_total', {
  description: 'Total errors by type and status code',
  unit: '1',
});
