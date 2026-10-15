import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { supabase } from '../lib/supabase.js';
import '../types.js';

export interface AppUser {
  id: string;
  role: string;
}

type Hook = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

declare module 'fastify' {
  interface FastifyInstance {
    authenticateDevice: Hook;
    authenticateUser: Hook;
    requireRole: (...roles: string[]) => Hook;
  }
  interface FastifyRequest {
    appUser: AppUser | null;
  }
}

const deny = (reply: FastifyReply, status: 401 | 403, code: string, message: string) =>
  reply.code(status).send({ ok: false, code, message });

export default fp(async (app) => {
  await app.register(jwt, {
    secret: config.jwtSecret,
    sign: { algorithm: 'HS256', iss: 'bus-telemetry-api' },
    verify: { algorithms: ['HS256'], allowedIss: 'bus-telemetry-api' },
  });

  app.decorateRequest('appUser', null);

  // Device (ESP32) JWT issued by POST /auth/device
  app.decorate('authenticateDevice', async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return deny(reply, 401, 'unauthorized', 'invalid or expired device token');
    }
    if (req.user.typ !== 'device') return deny(reply, 401, 'unauthorized', 'invalid token type');

    // Dynamic revocation & bus reassignment check:
    // Ensures a deactivated device cannot continue streaming telemetry with an existing 12-hour token
    const { data: dev, error } = await supabase
      .from('devices')
      .select('is_active, bus_id')
      .eq('device_id', req.user.sub)
      .maybeSingle();

    if (error || !dev || !dev.is_active) {
      return deny(reply, 401, 'unauthorized', 'device is inactive or revoked');
    }

    if (dev.bus_id && dev.bus_id !== req.user.bus_id) {
      req.user.bus_id = dev.bus_id;
    }
  });

  // Supabase Auth user JWT (Flutter app). Validated by Supabase itself.
  app.decorate('authenticateUser', async (req, reply) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return deny(reply, 401, 'unauthorized', 'missing bearer token');
    const { data, error } = await supabase.auth.getUser(h.slice(7));
    if (error || !data.user) return deny(reply, 401, 'unauthorized', 'invalid or expired token');
    const role = (data.user.app_metadata?.role as string | undefined) ?? 'user';
    req.appUser = { id: data.user.id, role };
  });

  // Roles live in Supabase app_metadata.role (set server-side only), e.g. 'admin' | 'driver'
  app.decorate('requireRole', (...roles: string[]): Hook => async (req, reply) => {
    if (!req.appUser) return deny(reply, 401, 'unauthorized', 'not authenticated');
    if (!roles.includes(req.appUser.role)) return deny(reply, 403, 'forbidden', 'insufficient role');
  });
});
