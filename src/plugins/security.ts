import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config.js';

export default fp(async (app) => {
  await app.register(helmet);
  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    methods: ['GET', 'POST'],
  });
  // Runs in preValidation: after auth (onRequest), before schema validation.
  // Keyed per device / user, falling back to IP for anonymous routes.
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.globalMax,
    timeWindow: '1 minute',
    hook: 'preValidation',
    keyGenerator: (req) =>
      (req.user as { sub?: string } | null)?.sub ?? req.appUser?.id ?? req.ip,
  });
});
