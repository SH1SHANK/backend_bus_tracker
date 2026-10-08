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

      const reject = (status: 401 | 403 | 422, code: string, message: string, label = 'rejected') => {
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

      // 5. anomaly detection against last accepted state
      const anomaly = detectAnomaly(body, await getLastState(device.bus_id));
      if (anomaly.kind === 'duplicate' || anomaly.kind === 'stale') return ignore(anomaly.kind);
      if (anomaly.kind === 'gps_jump' || anomaly.kind === 'impossible_speed')
        return reject(422, anomaly.kind, `implied speed ${Math.round(anomaly.impliedSpeedKmh)} km/h`, 'anomaly');
      if (anomaly.kind === 'ok' && anomaly.seqReset) req.log.info({ device: device.sub, seq: body.seq }, 'sequence reset (device reboot?)');

      // 6. processing  7. persist (atomic RPC)
      const processed = processTelemetry(body);
      const end = ingestLatency.startTimer();
      const result = await ingestTelemetry(device.sub, device.bus_id, processed);
      end();

      if (!result.ok) return reject(401, result.reason ?? 'device_inactive', 'device not authorised', 'rejected');
      if (!result.stored) return ignore(result.reason ?? 'duplicate');

      telemetryTotal.inc({ result: 'accepted', reason: processed.status });
      return { ok: true, stored: true, state_updated: result.state_updated, events: result.events ?? [] };
    },
  );
};
export default route;
