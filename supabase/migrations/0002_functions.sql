-- Atomic ingest: resolve device → bus/trip, store history, upsert current state,
-- run geofence (arrived/departed) + route-deviation detection. One round trip.
create or replace function public.ingest_telemetry(
  p_device_id text, p_bus_id uuid, p_seq bigint, p_recorded_at timestamptz,
  p_latitude numeric, p_longitude numeric, p_speed numeric, p_heading numeric,
  p_accuracy numeric, p_status text,
  p_stop_radius_m double precision default 50,
  p_deviation_m double precision default 500
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_device_pk uuid;
  v_device_bus uuid;
  v_trip_id uuid;
  v_route_id uuid;
  v_point geography;
  v_rows int;
  v_state_updated boolean := false;
  v_events jsonb := '[]'::jsonb;
  v_batch jsonb;
  v_path geography;
  v_dist double precision;
begin
  select id, bus_id into v_device_pk, v_device_bus
    from devices where device_id = p_device_id and is_active;
  if v_device_pk is null then
    return jsonb_build_object('ok', false, 'reason', 'device_inactive');
  end if;
  if v_device_bus <> p_bus_id then
    return jsonb_build_object('ok', false, 'reason', 'device_mismatch');
  end if;

  update devices set last_seen = now() where id = v_device_pk;

  select id, route_id into v_trip_id, v_route_id
    from trips where bus_id = p_bus_id and status = 'active' limit 1;

  v_point := st_setsrid(st_makepoint(p_longitude::float8, p_latitude::float8), 4326)::geography;

  -- history (dedupe on bus_id + recorded_at)
  insert into bus_positions (bus_id, trip_id, latitude, longitude, speed, heading, accuracy, seq, recorded_at)
  values (p_bus_id, v_trip_id, p_latitude, p_longitude, p_speed, p_heading, p_accuracy, p_seq, p_recorded_at)
  on conflict (bus_id, recorded_at) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('ok', true, 'stored', false, 'reason', 'duplicate');
  end if;

  -- current state: only moves forward in time (race-safe against concurrent packets)
  insert into bus_current_state as c
    (bus_id, trip_id, latitude, longitude, speed, heading, accuracy, seq, status, recorded_at, last_seen, updated_at)
  values
    (p_bus_id, v_trip_id, p_latitude, p_longitude, p_speed, p_heading, p_accuracy, p_seq, p_status, p_recorded_at, now(), now())
  on conflict (bus_id) do update set
    trip_id = excluded.trip_id, latitude = excluded.latitude, longitude = excluded.longitude,
    speed = excluded.speed, heading = excluded.heading, accuracy = excluded.accuracy,
    seq = excluded.seq, status = excluded.status, recorded_at = excluded.recorded_at,
    last_seen = now(), updated_at = now()
  where c.recorded_at < excluded.recorded_at;
  get diagnostics v_rows = row_count;
  v_state_updated := v_rows > 0;

  if v_state_updated and v_trip_id is not null then
    -- departures (hysteresis: 1.5x radius, avoids flapping on GPS noise)
    with last_ev as (
      select distinct on (stop_id) stop_id, event_type
        from bus_events
       where bus_id = p_bus_id and trip_id = v_trip_id and stop_id is not null
         and event_type in ('arrived','departed')
       order by stop_id, occurred_at desc
    ), ins as (
      insert into bus_events (bus_id, trip_id, stop_id, event_type, occurred_at, metadata)
      select p_bus_id, v_trip_id, l.stop_id, 'departed', p_recorded_at, jsonb_build_object('stop_code', s.code)
        from last_ev l join stops s on s.id = l.stop_id
       where l.event_type = 'arrived'
         and not st_dwithin(s.location, v_point, p_stop_radius_m * 1.5)
      returning stop_id
    )
    select coalesce(jsonb_agg(jsonb_build_object('type','departed','stop_id',stop_id)), '[]'::jsonb)
      into v_batch from ins;
    v_events := v_events || v_batch;

    -- arrivals
    with near as (
      select s.id as stop_id, s.code
        from route_stops rs join stops s on s.id = rs.stop_id
       where rs.route_id = v_route_id and s.is_active
         and st_dwithin(s.location, v_point, p_stop_radius_m)
    ), last_ev as (
      select distinct on (stop_id) stop_id, event_type
        from bus_events
       where bus_id = p_bus_id and trip_id = v_trip_id and stop_id is not null
         and event_type in ('arrived','departed')
       order by stop_id, occurred_at desc
    ), ins as (
      insert into bus_events (bus_id, trip_id, stop_id, event_type, occurred_at, metadata)
      select p_bus_id, v_trip_id, n.stop_id, 'arrived', p_recorded_at, jsonb_build_object('stop_code', n.code)
        from near n left join last_ev l on l.stop_id = n.stop_id
       where l.event_type is distinct from 'arrived'
      returning stop_id
    )
    select coalesce(jsonb_agg(jsonb_build_object('type','arrived','stop_id',stop_id)), '[]'::jsonb)
      into v_batch from ins;
    v_events := v_events || v_batch;

    -- route matching (deviation), debounced to once / 5 min / trip
    select coalesce(
             r.path,
             (select st_makeline(s.location::geometry order by rs.sequence)::geography
                from route_stops rs join stops s on s.id = rs.stop_id
               where rs.route_id = r.id
              having count(*) >= 2)
           )
      into v_path from routes r where r.id = v_route_id;

    if v_path is not null then
      v_dist := st_distance(v_path, v_point);
      if v_dist > p_deviation_m and not exists (
        select 1 from bus_events
         where trip_id = v_trip_id and event_type = 'route_deviation'
           and occurred_at > p_recorded_at - interval '5 minutes'
      ) then
        insert into bus_events (bus_id, trip_id, event_type, occurred_at, metadata)
        values (p_bus_id, v_trip_id, 'route_deviation', p_recorded_at,
                jsonb_build_object('distance_m', round(v_dist::numeric)));
        v_events := v_events || jsonb_build_array(
          jsonb_build_object('type','route_deviation','distance_m', round(v_dist::numeric)));
      end if;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'stored', true, 'state_updated', v_state_updated,
                            'bus_id', p_bus_id, 'trip_id', v_trip_id, 'events', v_events);
end $$;

revoke all on function public.ingest_telemetry(text,uuid,bigint,timestamptz,numeric,numeric,numeric,numeric,numeric,text,double precision,double precision)
  from public, anon, authenticated;
grant execute on function public.ingest_telemetry(text,uuid,bigint,timestamptz,numeric,numeric,numeric,numeric,numeric,text,double precision,double precision)
  to service_role;

-- ───────── spatial queries ─────────
create or replace function public.nearby_buses(
  p_lat double precision, p_lon double precision, p_radius_m double precision default 2000
) returns table (
  bus_id uuid, bus_number text, display_name text, latitude numeric, longitude numeric,
  speed numeric, heading numeric, status text, recorded_at timestamptz, distance_m double precision
)
language sql stable set search_path = public, extensions as $$
  with q as (select st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography as pt)
  select b.id, b.bus_number::text, b.display_name::text, c.latitude::numeric, c.longitude::numeric,
         c.speed::numeric, c.heading::numeric, c.status::text, c.recorded_at,
         st_distance(c.location, q.pt)
    from bus_current_state c
    join buses b on b.id = c.bus_id, q
   where b.is_active
     and c.last_seen > now() - interval '2 minutes'
     and st_dwithin(c.location, q.pt, p_radius_m)
   order by 10
$$;

create or replace function public.nearest_stops(
  p_lat double precision, p_lon double precision, p_limit int default 3
) returns table (
  stop_id uuid, code text, name text, latitude numeric, longitude numeric, distance_m double precision
)
language sql stable set search_path = public, extensions as $$
  with q as (select st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography as pt)
  select s.id, s.code::text, s.name::text, s.latitude::numeric, s.longitude::numeric,
         st_distance(s.location, q.pt)
    from stops s, q
   where s.is_active
   order by s.location <-> q.pt
   limit least(greatest(p_limit, 1), 20)
$$;

grant execute on function public.nearby_buses(double precision,double precision,double precision) to service_role, authenticated;
grant execute on function public.nearest_stops(double precision,double precision,int) to service_role, authenticated;
