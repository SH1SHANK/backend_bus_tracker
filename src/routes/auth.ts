import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { config } from '../config.js';
import { supabase } from '../lib/supabase.js';
import { hashSecret, verifySecret } from '../lib/password.js';
import { DeviceId, ErrorResponse } from '../schemas/telemetry.js';

const route: FastifyPluginAsyncTypebox = async (app) => {
  // Constant-time-ish path for unknown devices (no user enumeration)
  const dummyHash = await hashSecret('dummy-secret-for-timing');

  app.post(
    '/auth/device',
    {
      config: { rateLimit: { max: config.rateLimit.authMax, timeWindow: '1 minute' } },
      schema: {
        body: Type.Object(
          { device_id: DeviceId, secret: Type.String({ minLength: 16, maxLength: 128 }) },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ token: Type.String(), token_type: Type.Literal('Bearer'), expires_in: Type.Integer() }),
          '4xx': ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const { device_id, secret } = req.body;
      const { data, error } = await supabase
        .from('devices')
        .select('bus_id, credential_hash, is_active')
        .eq('device_id', device_id)
        .maybeSingle();
      if (error) throw new Error(error.message);

      const valid = await verifySecret(secret, data?.credential_hash ?? dummyHash);
      if (!data || !data.is_active || !valid) {
        return reply.code(401).send({ ok: false, code: 'invalid_credentials', message: 'invalid device credentials' });
      }

      const token = app.jwt.sign(
        { sub: device_id, bus_id: data.bus_id as string, typ: 'device' },
        { expiresIn: config.deviceTokenTtlS },
      );
      return { token, token_type: 'Bearer' as const, expires_in: config.deviceTokenTtlS };
    },
  );
};
export default route;
