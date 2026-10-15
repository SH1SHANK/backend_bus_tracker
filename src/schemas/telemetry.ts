import { Type, type Static } from '@sinclair/typebox';

export const DeviceId = Type.String({ minLength: 3, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' });

export const TelemetryBody = Type.Object(
  {
    device_id: DeviceId,
    seq: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    timestamp: Type.String({ format: 'date-time' }),
    latitude: Type.Number({ minimum: -90, maximum: 90 }),
    longitude: Type.Number({ minimum: -180, maximum: 180 }),
    speed: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 400 }), Type.Null()])), // km/h
    heading: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 360 }), Type.Null()])), // degrees
    accuracy: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 10_000 }), Type.Null()])), // metres
    // Epoch is strictly required per zero-legacy policy to disambiguate hardware sessions
    epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export type TelemetryInput = Static<typeof TelemetryBody>;

export const TelemetryBatchBody = Type.Object(
  {
    device_id: DeviceId,
    packets: Type.Array(TelemetryBody, { minItems: 1, maxItems: 50 }),
  },
  { additionalProperties: false },
);
export type TelemetryBatchInput = Static<typeof TelemetryBatchBody>;

export const TelemetryResponse = Type.Object({
  ok: Type.Boolean(),
  stored: Type.Boolean(),
  reason: Type.Optional(Type.String()),
  state_updated: Type.Optional(Type.Boolean()),
  events: Type.Optional(Type.Array(Type.Any())),
});

export const TelemetryBatchResponse = Type.Object({
  ok: Type.Boolean(),
  accepted: Type.Integer(),
  duplicates: Type.Integer(),
  rejected: Type.Integer(),
  results: Type.Array(
    Type.Object({
      seq: Type.Integer(),
      epoch: Type.Integer(),
      ok: Type.Boolean(),
      stored: Type.Boolean(),
      code: Type.String(),
    }),
  ),
});

export const ErrorResponse = Type.Object({
  ok: Type.Literal(false),
  code: Type.String(),
  message: Type.String(),
});
