import { Type, type Static } from '@sinclair/typebox';

export const DeviceId = Type.String({ minLength: 3, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' });

export const TelemetryBody = Type.Object(
  {
    device_id: DeviceId,
    seq: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    timestamp: Type.String({ format: 'date-time' }),
    latitude: Type.Number({ minimum: -90, maximum: 90 }),
    longitude: Type.Number({ minimum: -180, maximum: 180 }),
    speed: Type.Number({ minimum: 0, maximum: 400 }), // km/h
    heading: Type.Number({ minimum: 0, maximum: 360 }), // degrees
    accuracy: Type.Number({ minimum: 0, maximum: 10_000 }), // metres
  },
  { additionalProperties: false },
);
export type TelemetryInput = Static<typeof TelemetryBody>;

export const TelemetryResponse = Type.Object({
  ok: Type.Boolean(),
  stored: Type.Boolean(),
  reason: Type.Optional(Type.String()),
  state_updated: Type.Optional(Type.Boolean()),
  events: Type.Optional(Type.Array(Type.Any())),
});

export const ErrorResponse = Type.Object({
  ok: Type.Literal(false),
  code: Type.String(),
  message: Type.String(),
});
