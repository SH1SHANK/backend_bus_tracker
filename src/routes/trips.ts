import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { supabase } from '../lib/supabase.js';

const uuid = Type.String({ format: 'uuid' });

const route: FastifyPluginAsyncTypebox = async (app) => {
  const staff = { onRequest: [app.authenticateUser, app.requireRole('admin', 'driver')] };

  app.post(
    '/trips/start',
    { ...staff, schema: { body: Type.Object({ bus_id: uuid, route_id: uuid }, { additionalProperties: false }) } },
    async (req, reply) => {
      const { bus_id, route_id } = req.body;
      const { data, error } = await supabase
        .from('trips')
        .insert({ bus_id, route_id, status: 'active', started_at: new Date().toISOString() })
        .select('id, bus_id, route_id, status, started_at')
        .single();
      if (error) {
        if (error.code === '23505')
          return reply.code(409).send({ ok: false, code: 'trip_already_active', message: 'bus already has an active trip' });
        if (error.code === '23503')
          return reply.code(422).send({ ok: false, code: 'unknown_reference', message: 'bus_id or route_id not found' });
        throw new Error(error.message);
      }
      await supabase.from('bus_events').insert({
        bus_id, trip_id: data.id, event_type: 'trip_started', occurred_at: data.started_at,
      });
      return reply.code(201).send(data);
    },
  );

  app.post(
    '/trips/:id/end',
    { ...staff, schema: { params: Type.Object({ id: uuid }) } },
    async (req, reply) => {
      const { data, error } = await supabase
        .from('trips')
        .update({ status: 'completed', ended_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('status', 'active')
        .select('id, bus_id, status, started_at, ended_at')
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return reply.code(404).send({ ok: false, code: 'not_found', message: 'no active trip with that id' });
      await supabase.from('bus_events').insert({
        bus_id: data.bus_id, trip_id: data.id, event_type: 'trip_ended', occurred_at: data.ended_at,
      });
      return data;
    },
  );
};
export default route;
