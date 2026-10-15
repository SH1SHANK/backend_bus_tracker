import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { config } from '../config.js';
import { ingestLatency, telemetryTotal } from '../lib/metrics.js';
import { getLastState, ingestTelemetry } from '../repositories/telemetry.repo.js';
import {
  ErrorResponse,
  TelemetryBatchBody,
  TelemetryBatchResponse,
  TelemetryBody,
  TelemetryResponse,
} from '../schemas/telemetry.js';
import { detectAnomaly } from '../services/anomaly.js';
import { processTelemetry } from '../services/processing.js';
import { validateTelemetry } from '../services/validation.js';

const route: FastifyPluginAsyncTypebox = async (app) => {
  // Pipeline: 1 JWT signature verify (onRequest) → 2 rate limit (preValidation)
  //  → 3 JSON schema → 4 active device DB check (preHandler) → 5 validation → 6 anomaly → 7 persist
  app.post(
    '/telemetry',
    {
      onRequest: [app.authenticateDevice],
      preHandler: [app.verifyDeviceActive],
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

      if (body.device_id !== device.sub)
        return reject(403, 'device_mismatch', 'device_id does not match token');

      // Stateless validation
      const invalid = validateTelemetry(body);
      if (invalid) return reject(422, invalid.code, invalid.message);

      // Anomaly detection (GPS jump checks against last accepted state)
      const lastState = await getLastState(device.bus_id);
      if (lastState) {
        const anomaly = detectAnomaly(body, lastState);
        if (anomaly.kind === 'gps_jump' || anomaly.kind === 'impossible_speed') {
          return reject(422, anomaly.kind, `implied speed ${Math.round(anomaly.impliedSpeedKmh)} km/h`, 'anomaly');
        }
      }

      // Normalise & persist via atomic RPC
      const processed = processTelemetry(body);
      const end = ingestLatency.startTimer();
      const result = await ingestTelemetry(device.sub, device.bus_id, processed);
      end();

      if (!result || typeof result !== 'object') {
        throw new Error('Invalid or empty response from ingest_telemetry_packet');
      }

      // Handle idempotent duplicate packet from RPC
      if (result.ok && result.code === 'DUPLICATE_PACKET') {
        telemetryTotal.inc({ result: 'ignored', reason: 'duplicate' });
        return reply.code(200).send({
          ok: true,
          stored: false,
          state_updated: false,
          reason: 'duplicate',
        });
      }

      if (result.ok) {
        telemetryTotal.inc({ result: 'accepted', reason: processed.status });
        return {
          ok: true,
          stored: Boolean(result.stored ?? result.pos_inserted ?? true),
          state_updated: Boolean(result.state_updated ?? false),
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

  // Batch ingestion endpoint for flushing offline ESP32 buffer after cellular dead zones
  app.post(
    '/telemetry/batch',
    {
      onRequest: [app.authenticateDevice],
      preHandler: [app.verifyDeviceActive],
      config: { rateLimit: { max: config.rateLimit.telemetryMax, timeWindow: '1 minute' } },
      schema: {
        body: TelemetryBatchBody,
        response: { 200: TelemetryBatchResponse, '4xx': ErrorResponse },
      },
    },
    async (req, reply) => {
      const { device_id, packets } = req.body;
      const device = req.user;

      if (device_id !== device.sub) {
        return reply.code(403).send({
          ok: false,
          code: 'device_mismatch',
          message: 'device_id does not match token',
        });
      }

      let accepted = 0;
      let duplicates = 0;
      let rejected = 0;
      const results: Array<{ seq: number; epoch: number; ok: boolean; stored: boolean; code: string }> = [];

      // Sort packets by (epoch, seq) ascending so buffered fixes replay in monotonic order
      const ordered = [...packets].sort((a, b) => (a.epoch !== b.epoch ? a.epoch - b.epoch : a.seq - b.seq));

      for (const pkt of ordered) {
        if (pkt.device_id !== device.sub) {
          rejected++;
          results.push({ seq: pkt.seq, epoch: pkt.epoch, ok: false, stored: false, code: 'device_mismatch' });
          continue;
        }
        const invalid = validateTelemetry(pkt);
        if (invalid) {
          rejected++;
          results.push({ seq: pkt.seq, epoch: pkt.epoch, ok: false, stored: false, code: invalid.code });
          continue;
        }
        const processed = processTelemetry(pkt);
        const res = await ingestTelemetry(device.sub, device.bus_id, processed);
        if (res?.ok && res.code === 'DUPLICATE_PACKET') {
          duplicates++;
          results.push({ seq: pkt.seq, epoch: pkt.epoch, ok: true, stored: false, code: 'DUPLICATE_PACKET' });
        } else if (res?.ok) {
          accepted++;
          results.push({ seq: pkt.seq, epoch: pkt.epoch, ok: true, stored: true, code: 'SUCCESS' });
        } else {
          rejected++;
          results.push({
            seq: pkt.seq,
            epoch: pkt.epoch,
            ok: false,
            stored: false,
            code: res?.code || 'UNKNOWN_ERROR',
          });
        }
      }

      return {
        ok: rejected === 0,
        accepted,
        duplicates,
        rejected,
        results,
      };
    },
  );
};
export default route;
