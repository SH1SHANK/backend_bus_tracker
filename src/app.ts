import Fastify, { type FastifyError } from 'fastify';
import * as Sentry from '@sentry/node';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { config } from './config.js';
import './types.js';
import securityPlugin from './plugins/security.js';
import authPlugin from './plugins/auth.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import telemetryRoutes from './routes/telemetry.js';
import busRoutes from './routes/buses.js';
import tripRoutes from './routes/trips.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization'],
      transport: config.env === 'development' ? { target: 'pino-pretty' } : undefined,
    },
    trustProxy: config.trustedProxies, // RFC1918 private subnets and loopback
    bodyLimit: 16 * 1024,
    ajv: { customOptions: { removeAdditional: false } }, // reject unknown fields, don't silently strip
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    const code =
      status === 429 ? 'rate_limited' : err.validation ? 'invalid_request' : status >= 500 ? 'internal_error' : 'bad_request';
    reply.code(status).send({
      ok: false,
      code,
      message: status >= 500 ? 'internal server error' : err.message,
    });
  });

  // auth must register before security so req.user/appUser exist for rate-limit keys
  await app.register(authPlugin);
  await app.register(securityPlugin);

  await app.register(healthRoutes);
  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(telemetryRoutes);
      await api.register(busRoutes);
      await api.register(tripRoutes);
    },
    { prefix: '/api/v1' },
  );

  if (config.sentryDsn) Sentry.setupFastifyErrorHandler(app);

  return app;
}
