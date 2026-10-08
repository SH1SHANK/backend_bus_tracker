import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { supabase } from '../lib/supabase.js';
import { registry } from '../lib/metrics.js';

const route: FastifyPluginAsync = async (app) => {
  const noLimit = { config: { rateLimit: false as const } };

  app.get('/healthz', noLimit, async () => ({ status: 'ok', uptime: process.uptime() }));

  app.get('/readyz', noLimit, async (_req, reply) => {
    const { error } = await supabase.from('buses').select('id').limit(1);
    if (error) return reply.code(503).send({ status: 'unavailable' });
    return { status: 'ready' };
  });

  app.get('/metrics', noLimit, async (req, reply) => {
    if (!config.metricsToken) return reply.code(404).send();
    if (req.headers.authorization !== `Bearer ${config.metricsToken}`) return reply.code(401).send();
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
};
export default route;
