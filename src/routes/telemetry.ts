import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { config } from '../config.js';
import { ingestLatency, telemetryTotal } from '../lib/metrics.js';
import { getLastState, ingestTelemetry } from '../repositories/telemetry.repo.js';
import { ErrorResponse, TelemetryBody, TelemetryResponse } from '../schemas/telemetry.js';
import { detectAnomaly } from '../services/anomaly.js';
import { processTelemetry } from '../services/processing.js';
import { validateTelemetry } from '../services/validation.js';

const route: FastifyPluginAsyncTypebox = async (app) => {
  // Pipeline: 1 JWT auth (onRequest) → 2 rate limit (preValidation)
  //  → 3 JSON schema → 4 validation → 5 anomaly → 6 processing → 7 insert
  app.post(
    '/telemetry',
    {
      onRequest: [app.authenticateDevice],
      config: { rateLimit: { max: config.rateLimit.telemetryMax, timeWindow: '1 minute' } },
      schema: {
        body: TelemetryBody,
        response: { 200: TelemetryResponse, '4xx': ErrorResponse },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const device = req.user;

      const reject = (
        status: 400 | 401 | 403 | 409 | 422,
        code: string,
        message: string,
        label = 'rejected',
      ) => {
        telemetryTotal.inc({ result: label, reason: code });
        req.log.warn({ device: device.sub, code }, 'telemetry rejected');
        return reply.code(status).send({ ok: false as const, code, message });
      };
      const ignore = (reason: string) => {
        telemetryTotal.inc({ result: 'ignored', reason });
        return reply.code(200).send({ ok: true, stored: false, reason });
      };

      if (body.device_id !== device.sub)
        return reject(403, 'device_mismatch', 'device_id does not match token');

      // 4. validation
      const invalid = validateTelemetry(body);
      if (invalid) return reject(422, invalid.code, invalid.message);

      // 5. anomaly detection (GPS jump checks against last accepted state)
      const lastState = await getLastState(device.bus_id);
      if (lastState) {
        const anomaly = detectAnomaly(body, lastState);
        if (anomaly.kind === 'gps_jump' || anomaly.kind === 'impossible_speed') {
          return reject(422, anomaly.kind, `implied speed ${Math.round(anomaly.impliedSpeedKmh)} km/h`, 'anomaly');
        }
      }

      // 6. processing  7. persist (atomic RPC)
      const processed = processTelemetry(body);
      const end = ingestLatency.startTimer();
      const result = await ingestTelemetry(device.sub, device.bus_id, processed);
      end();

      // Handle idempotent duplicate packet from RPC
      if (result.ok && result.code === 'DUPLICATE_PACKET') {
        return reply.code(200).send({
          ok: true,
          stored: false,
          reason: 'duplicate',
        });
      }

      if (result.ok) {
        telemetryTotal.inc({ result: 'accepted', reason: processed.status });
        return {
          ok: true,
          stored: true,
          state_updated: result.state_updated,
          events: result.events ?? [],
        };
      }

      // Rejections from database RPC
      const code = result.code || 'UNKNOWN_ERROR';
      const msg = result.error || 'telemetry rejected';

      if (code === 'UNAUTHORIZED_DEVICE' || code === 'INACTIVE_BUS') {
        return reject(401, code, msg, 'rejected');
      }
      if (
        code === 'STALE_EPOCH_PACKET' ||
        code === 'UNAUTHORIZED_EPOCH' ||
        code === 'INVALID_SEQUENCE' ||
        code === 'SEQUENCE_REUSE_CONFLICT' ||
        code === 'OUT_OF_ORDER_PACKET'
      ) {
        return reject(409, code, msg, 'conflict');
      }
      if (
        code === 'COORDINATES_OUT_OF_BOUNDS' ||
        code === 'INVALID_SPEED' ||
        code === 'INVALID_HEADING' ||
        code === 'INVALID_ACCURACY' ||
        code === 'IMPLAUSIBLE_TIMESTAMP'
      ) {
        return reject(422, code, msg, 'invalid');
      }

      return reject(400, code, msg, 'rejected');
    },
  );
};
export default route;
