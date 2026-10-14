import { Type, type Static } from '@sinclair/typebox';
import { DeviceId } from './telemetry.js';

export const DeviceAuthBody = Type.Object(
  {
    device_id: DeviceId,
    secret: Type.String({ minLength: 16, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type DeviceAuthInput = Static<typeof DeviceAuthBody>;

export const ResetSessionBody = Type.Object(
  {
    device_id: DeviceId,
    secret: Type.String({ minLength: 16, maxLength: 128 }),
    session_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    reason: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { additionalProperties: false },
);
export type ResetSessionInput = Static<typeof ResetSessionBody>;

export const ResetSessionResponse = Type.Object({
  ok: Type.Boolean(),
  code: Type.String(),
  epoch: Type.Integer(),
  device_id: Type.String(),
  bus_id: Type.String(),
  idempotent_retry: Type.Boolean(),
});
