import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { config } from '../config.js';
import { supabase } from '../lib/supabase.js';

const isOnline = (lastSeen?: string | null) =>
  !!lastSeen && Date.now() - Date.parse(lastSeen) < config.telemetry.onlineWindowS * 1000;

const normalizeState = (raw: any) => (Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null));

const lat = Type.Number({ minimum: -90, maximum: 90 });
const lon = Type.Number({ minimum: -180, maximum: 180 });

const route: FastifyPluginAsyncTypebox = async (app) => {
  const auth = { onRequest: [app.authenticateUser] };

  // All active buses + current state
  app.get('/buses', auth, async () => {
    const { data, error } = await supabase
      .from('buses')
      .select('id, bus_number, display_name, bus_current_state(*)')
      .eq('is_active', true);
    if (error) throw new Error(error.message);
    return (data ?? []).map((b: any) => {
      const state = normalizeState(b.bus_current_state);
      return {
        ...b,
        bus_current_state: state,
        is_online: isOnline(state?.last_seen),
      };
    });
  });

  // Spatial: buses within radius of a point
  app.get(
    '/buses/nearby',
    {
      ...auth,
      schema: {
        querystring: Type.Object({
          lat,
          lon,
          radius: Type.Number({ minimum: 1, maximum: 20_000, default: 2000 }),
        }),
      },
    },
    async (req) => {
      const { lat, lon, radius } = req.query;
      const { data, error } = await supabase.rpc('get_nearby_buses', {
        p_latitude: lat,
        p_longitude: lon,
        p_radius_meters: radius,
        p_limit: 20,
      });
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  );

  // One bus: info, current state, active trip + route
  app.get(
    '/buses/:id',
    { ...auth, schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }) } },
    async (req, reply) => {
      const { id } = req.params;
      const { data: bus, error } = await supabase
        .from('buses')
        .select('id, bus_number, display_name, is_active, bus_current_state(*)')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!bus) return reply.code(404).send({ ok: false, code: 'not_found', message: 'bus not found' });

      const { data: trip } = await supabase
        .from('trips')
        .select('id, status, started_at, routes(id, name, direction)')
        .eq('bus_id', id)
        .eq('status', 'active')
        .maybeSingle();

      const state = normalizeState((bus as any).bus_current_state);
      return {
        ...bus,
        bus_current_state: state,
        is_online: isOnline(state?.last_seen),
        active_trip: trip ?? null,
      };
    },
  );

  // Spatial: nearest stops to a point
  app.get(
    '/stops/nearest',
    {
      ...auth,
      schema: {
        querystring: Type.Object({
          lat,
          lon,
          limit: Type.Integer({ minimum: 1, maximum: 10, default: 3 }),
          radius: Type.Number({ minimum: 100, maximum: 50_000, default: 5000 }),
        }),
      },
    },
    async (req) => {
      const { lat, lon, limit, radius } = req.query;
      const { data, error } = await supabase.rpc('get_nearby_stops', {
        p_latitude: lat,
        p_longitude: lon,
        p_radius_meters: radius,
        p_limit: limit,
      });
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  );
};
export default route;
