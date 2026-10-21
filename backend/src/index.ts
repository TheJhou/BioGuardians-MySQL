// OpenTelemetry instrumentation MUST be imported first so auto-instrumentation
// can patch Express, mysql2, http, etc. before they're loaded.
import './telemetry/instrumentation.js';

import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { logger } from './telemetry/logger.js';
import referenciasRoutes from './routes/referencias.js';
import especiesRoutes from './routes/especies.js';
import areasRoutes from './routes/areas.js';
import ocorrenciasRoutes from './routes/ocorrencias.js';
import dashboardRoutes from './routes/dashboard.js';
import deteccoesRoutes from './routes/deteccoes.js';
import { warmupTileCache } from './tileWarmup.js';

const app = express();

// --- Middleware ---
// API somente leitura: só GET (e o preflight OPTIONS) é aceito.
app.use(cors({ origin: env.corsOrigin, methods: ['GET'] }));
app.use(requestLogger);

// --- Health check ---
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Routes ---
app.use('/api', referenciasRoutes);
app.use('/api/especies', especiesRoutes);
app.use('/api/areas', areasRoutes);
app.use('/api/ocorrencias', ocorrenciasRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/deteccoes', deteccoesRoutes);

// --- Error handling ---
app.use(errorHandler);

// --- Start ---
app.listen(env.port, () => {
  logger.info('server_listening', { port: env.port });
  if (env.tileWarmup) warmupTileCache(env.port);
});

export default app;
