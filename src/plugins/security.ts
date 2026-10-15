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
  // Runs in preValidation: after JWT signature verify (onRequest) and body parsing, before schema/DB checks.
  // Keyed per device / user, or per (IP + device_id) on unauthenticated device boot routes to avoid CGNAT collisions.
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.globalMax,
    timeWindow: '1 minute',
    hook: 'preValidation',
    keyGenerator: (req) => {
      const deviceSub = (req.user as { sub?: string } | null)?.sub;
      if (deviceSub) return deviceSub;
      if (req.appUser?.id) return req.appUser.id;
      const bodyObj = req.body as Record<string, unknown> | null | undefined;
      if (bodyObj && typeof bodyObj === 'object' && typeof bodyObj.device_id === 'string') {
        return `${req.ip}:${bodyObj.device_id}`;
      }
      return req.ip;
    },
  });
});
