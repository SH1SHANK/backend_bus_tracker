-- Canonical Supabase RPC Functions for Tracklet Bus Telemetry Backend

-- 1. Provision / Register Tracking Device (Bcrypt 8 rounds via pgcrypto)
create or replace function public.register_tracking_device(
  p_device_id text,
  p_bus_number text,
  p_secret text,
  p_allow_reassign boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_bus_id uuid;
  v_device_pk uuid;
  v_existing_device text;
  v_epoch bigint := 1;
begin
  if p_device_id is null or length(trim(p_device_id)) < 3 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_ID', 'error', 'device_id must be at least 3 characters');
  end if;

  if p_secret is null or length(p_secret) < 16 then
    return jsonb_build_object('ok', false, 'code', 'WEAK_SECRET', 'error', 'secret must be at least 16 characters');
  end if;

  select id into v_bus_id from public.buses where bus_number = p_bus_number;
  if v_bus_id is null then
    insert into public.buses (bus_number, display_name, is_active)
    values (p_bus_number, p_bus_number, true)
    returning id into v_bus_id;
  end if;

  select device_id into v_existing_device
    from public.devices
   where bus_id = v_bus_id and is_active = true and device_id <> p_device_id
   limit 1;

  if v_existing_device is not null then
    if not coalesce(p_allow_reassign, false) then
      return jsonb_build_object(
        'ok', false,
        'code', 'BUS_ALREADY_ASSIGNED',
        'error', format('Bus %s already has an active device (%s)', p_bus_number, v_existing_device)
      );
    end if;
    update public.devices
       set is_active = false, updated_at = now()
     where bus_id = v_bus_id and is_active = true and device_id <> p_device_id;
  end if;

  insert into public.devices (device_id, bus_id, credential_hash, is_active, current_epoch, last_session_id, updated_at)
  values (
    p_device_id,
    v_bus_id,
    extensions.crypt(p_secret, extensions.gen_salt('bf', 8)),
    true,
    1,
    null,
    now()
  )
  on conflict (device_id) do update set
    bus_id = excluded.bus_id,
    credential_hash = excluded.credential_hash,
    is_active = true,
    current_epoch = greatest(public.devices.current_epoch, 1),
    updated_at = now()
  returning id, current_epoch into v_device_pk, v_epoch;

  return jsonb_build_object(
    'ok', true,
    'code', 'SUCCESS',
    'device_pk', v_device_pk,
    'device_id', p_device_id,
    'bus_id', v_bus_id,
    'epoch', v_epoch
  );
end;
$$;

-- 2. Reboot / Session Sequence Reset with Idempotent session_id Retry
create or replace function public.reset_device_sequence(
  p_device_id text,
  p_secret text,
  p_session_id text default null,
  p_reason text default 'firmware_reboot'
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_device_pk uuid;
  v_bus_id uuid;
  v_hash text;
  v_is_active boolean;
  v_current_epoch bigint;
  v_last_session text;
  v_new_epoch bigint;
begin
  if p_device_id is null or p_secret is null or length(p_secret) < 16 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CREDENTIALS', 'error', 'Invalid device credentials');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_device_id));

  select id, bus_id, credential_hash, is_active, current_epoch, last_session_id
    into v_device_pk, v_bus_id, v_hash, v_is_active, v_current_epoch, v_last_session
    from public.devices
   where device_id = p_device_id
   for update;

  if v_device_pk is null or not v_is_active then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CREDENTIALS', 'error', 'Invalid or inactive device');
  end if;

  if extensions.crypt(p_secret, v_hash) <> v_hash then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CREDENTIALS', 'error', 'Invalid device credentials');
  end if;

  -- Idempotent retry check if cellular dropped the previous HTTP 200 response
  if p_session_id is not null and length(trim(p_session_id)) > 0 and v_last_session = p_session_id then
    return jsonb_build_object(
      'ok', true,
      'code', 'SUCCESS',
      'device_id', p_device_id,
      'bus_id', v_bus_id,
      'epoch', v_current_epoch,
      'new_epoch', v_current_epoch,
      'idempotent_retry', true
    );
  end if;

  v_new_epoch := coalesce(v_current_epoch, 1) + 1;

  update public.devices
     set current_epoch = v_new_epoch,
         last_session_id = p_session_id,
         last_seen = now(),
         updated_at = now()
   where id = v_device_pk;

  update public.bus_current_state
     set epoch = v_new_epoch,
         seq = 0,
         device_id = p_device_id,
         updated_at = now()
   where bus_id = v_bus_id;

  insert into public.bus_events (bus_id, event_type, occurred_at, metadata)
  values (
    v_bus_id,
    'device_sequence_reset',
    now(),
    jsonb_build_object(
      'device_id', p_device_id,
      'epoch', v_new_epoch,
      'session_id', p_session_id,
      'reason', coalesce(p_reason, 'firmware_reboot')
    )
  );

  return jsonb_build_object(
    'ok', true,
    'code', 'SUCCESS',
    'device_id', p_device_id,
    'bus_id', v_bus_id,
    'epoch', v_new_epoch,
    'new_epoch', v_new_epoch,
    'idempotent_retry', false
  );
end;
$$;

-- 3. Atomic Telemetry Packet Ingestion
create or replace function public.ingest_telemetry_packet(
  p_device_id text,
  p_seq bigint,
  p_timestamp timestamptz,
  p_latitude numeric,
  p_longitude numeric,
  p_speed numeric default null,
  p_heading numeric default null,
  p_accuracy numeric default null,
  p_status text default null,
  p_stop_radius_m double precision default 50.0,
  p_deviation_m double precision default 500.0,
  p_epoch bigint default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_device_pk uuid;
  v_bus_id uuid;
  v_bus_active boolean;
  v_dev_epoch bigint;
  v_epoch bigint;
  v_trip_id uuid;
  v_route_id uuid;
  v_status text;
  v_existing record;
  v_cur record;
  v_point extensions.geography;
  v_path extensions.geography;
  v_dist double precision;
  v_state_updated boolean := false;
  v_events jsonb := '[]'::jsonb;
  v_batch jsonb;
begin
  -- Serialize concurrent requests per device
  perform pg_advisory_xact_lock(hashtext(coalesce(p_device_id, '')));

  select d.id, d.bus_id, d.current_epoch, b.is_active
    into v_device_pk, v_bus_id, v_dev_epoch, v_bus_active
    from public.devices d
    join public.buses b on b.id = d.bus_id
   where d.device_id = p_device_id and d.is_active = true;

  if v_device_pk is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED_DEVICE', 'error', 'Device not registered or inactive');
  end if;

  if not coalesce(v_bus_active, false) then
    return jsonb_build_object('ok', false, 'code', 'INACTIVE_BUS', 'error', 'Assigned bus is inactive');
  end if;

  if p_seq is null or p_seq < 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SEQUENCE', 'error', 'Sequence number must be non-negative');
  end if;

  v_epoch := coalesce(p_epoch, v_dev_epoch, 1);
  if v_epoch < v_dev_epoch then
    return jsonb_build_object('ok', false, 'code', 'STALE_EPOCH_PACKET', 'error', 'Packet epoch is older than current device session');
  elsif v_epoch > v_dev_epoch then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED_EPOCH', 'error', 'Packet epoch has not been negotiated via reset-session');
  end if;

  -- Coordinate & metric invariants (NITC Kozhikode transit corridor)
  if p_latitude is null or p_longitude is null
     or p_latitude < 11.200000 or p_latitude > 11.450000
     or p_longitude < 75.800000 or p_longitude > 76.100000 then
    return jsonb_build_object('ok', false, 'code', 'COORDINATES_OUT_OF_BOUNDS', 'error', 'Latitude or longitude outside valid regional transit bounds');
  end if;

  if p_speed is not null and (p_speed < 0 or p_speed > 120) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SPEED', 'error', 'Speed outside plausible range (0..120 km/h)');
  end if;

  if p_heading is not null and (p_heading < 0 or p_heading >= 360) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_HEADING', 'error', 'Heading must be in [0, 360)');
  end if;

  if p_accuracy is not null and (p_accuracy < 0 or p_accuracy > 500) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ACCURACY', 'error', 'Accuracy outside allowed range (0..500 m)');
  end if;

  if p_timestamp is null
     or p_timestamp > now() + interval '60 seconds'
     or p_timestamp < now() - interval '15 minutes' then
    return jsonb_build_object('ok', false, 'code', 'IMPLAUSIBLE_TIMESTAMP', 'error', 'Timestamp outside allowed clock drift window');
  end if;

  v_status := coalesce(p_status, case when coalesce(p_speed, 0) >= 2 then 'moving' else 'stationary' end);

  select id, route_id into v_trip_id, v_route_id
    from public.trips
   where bus_id = v_bus_id and status = 'active'
   order by started_at desc nulls last
   limit 1;

  -- Check if (device_id, epoch, seq) was already recorded (idempotent duplicate vs conflicting sequence reuse)
  select recorded_at, latitude, longitude, speed, heading, accuracy, status
    into v_existing
    from public.bus_positions
   where device_id = p_device_id and epoch = v_epoch and seq = p_seq;

  if found then
    if v_existing.recorded_at = p_timestamp
       and v_existing.latitude = round(p_latitude, 6)
       and v_existing.longitude = round(p_longitude, 6)
       and v_existing.speed is not distinct from round(p_speed, 1)
       and v_existing.heading is not distinct from round(p_heading, 1)
       and v_existing.accuracy is not distinct from round(p_accuracy, 1)
       and v_existing.status is not distinct from v_status then
      return jsonb_build_object(
        'ok', true,
        'code', 'DUPLICATE_PACKET',
        'stored', false,
        'state_updated', false,
        'bus_id', v_bus_id,
        'trip_id', v_trip_id,
        'events', '[]'::jsonb
      );
    else
      return jsonb_build_object(
        'ok', false,
        'code', 'SEQUENCE_REUSE_CONFLICT',
        'error', 'Sequence number was previously used with conflicting telemetry data'
      );
    end if;
  end if;

  -- Lock current state row for this bus if present
  select device_id, epoch, seq, recorded_at
    into v_cur
    from public.bus_current_state
   where bus_id = v_bus_id
   for update;

  if found then
    if v_cur.device_id = p_device_id and v_cur.epoch = v_epoch then
      if p_seq <= v_cur.seq then
        return jsonb_build_object('ok', false, 'code', 'OUT_OF_ORDER_PACKET', 'error', 'Sequence number is not strictly increasing');
      end if;
      if v_cur.seq > 0 and p_timestamp <= v_cur.recorded_at then
        return jsonb_build_object('ok', false, 'code', 'OUT_OF_ORDER_PACKET', 'error', 'Timestamp is not newer than current state');
      end if;
    end if;
  end if;

  update public.devices set last_seen = now(), updated_at = now() where id = v_device_pk;

  insert into public.bus_positions (
    bus_id, trip_id, device_id, epoch, seq,
    latitude, longitude, speed, heading, accuracy, status, recorded_at
  ) values (
    v_bus_id, v_trip_id, p_device_id, v_epoch, p_seq,
    round(p_latitude, 6), round(p_longitude, 6),
    round(p_speed, 1), round(p_heading, 1), round(p_accuracy, 1),
    v_status, p_timestamp
  );

  insert into public.bus_current_state as c (
    bus_id, trip_id, device_id, epoch, seq,
    latitude, longitude, speed, heading, accuracy, status,
    recorded_at, last_seen, updated_at
  ) values (
    v_bus_id, v_trip_id, p_device_id, v_epoch, p_seq,
    round(p_latitude, 6), round(p_longitude, 6),
    round(p_speed, 1), round(p_heading, 1), round(p_accuracy, 1),
    v_status, p_timestamp, now(), now()
  )
  on conflict (bus_id) do update set
    trip_id = excluded.trip_id,
    device_id = excluded.device_id,
    epoch = excluded.epoch,
    seq = excluded.seq,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    speed = excluded.speed,
    heading = excluded.heading,
    accuracy = excluded.accuracy,
    status = excluded.status,
    recorded_at = excluded.recorded_at,
    last_seen = now(),
    updated_at = now();

  v_state_updated := true;
  v_point := extensions.st_setsrid(extensions.st_makepoint(p_longitude::float8, p_latitude::float8), 4326)::extensions.geography;

  if v_state_updated and v_trip_id is not null then
    -- Departures (1.5x stop radius hysteresis)
    with last_ev as (
      select distinct on (stop_id) stop_id, event_type
        from public.bus_events
       where bus_id = v_bus_id and trip_id = v_trip_id and stop_id is not null
         and event_type in ('arrived','departed')
       order by stop_id, occurred_at desc
    ), ins as (
      insert into public.bus_events (bus_id, trip_id, stop_id, event_type, occurred_at, metadata)
      select v_bus_id, v_trip_id, l.stop_id, 'departed', p_timestamp, jsonb_build_object('stop_code', s.code)
        from last_ev l join public.stops s on s.id = l.stop_id
       where l.event_type = 'arrived'
         and not extensions.st_dwithin(s.location, v_point, p_stop_radius_m * 1.5)
      returning stop_id
    )
    select coalesce(jsonb_agg(jsonb_build_object('type','departed','stop_id',stop_id)), '[]'::jsonb)
      into v_batch from ins;
    v_events := v_events || v_batch;

    -- Arrivals
    with near as (
      select s.id as stop_id, s.code
        from public.route_stops rs join public.stops s on s.id = rs.stop_id
       where rs.route_id = v_route_id and s.is_active
         and extensions.st_dwithin(s.location, v_point, p_stop_radius_m)
    ), last_ev as (
      select distinct on (stop_id) stop_id, event_type
        from public.bus_events
       where bus_id = v_bus_id and trip_id = v_trip_id and stop_id is not null
         and event_type in ('arrived','departed')
       order by stop_id, occurred_at desc
    ), ins as (
      insert into public.bus_events (bus_id, trip_id, stop_id, event_type, occurred_at, metadata)
      select v_bus_id, v_trip_id, n.stop_id, 'arrived', p_timestamp, jsonb_build_object('stop_code', n.code)
        from near n left join last_ev l on l.stop_id = n.stop_id
       where l.event_type is distinct from 'arrived'
      returning stop_id
    )
    select coalesce(jsonb_agg(jsonb_build_object('type','arrived','stop_id',stop_id)), '[]'::jsonb)
      into v_batch from ins;
    v_events := v_events || v_batch;

    -- Route deviation detection (debounced to once per 5 minutes per trip)
    select coalesce(
             r.path,
             (select extensions.st_makeline(s.location::extensions.geometry order by rs.sequence)::extensions.geography
                from public.route_stops rs join public.stops s on s.id = rs.stop_id
               where rs.route_id = r.id
              having count(*) >= 2)
           )
      into v_path from public.routes r where r.id = v_route_id;

    if v_path is not null then
      v_dist := extensions.st_distance(v_path, v_point);
      if v_dist > p_deviation_m and not exists (
        select 1 from public.bus_events
         where trip_id = v_trip_id and event_type = 'route_deviation'
           and occurred_at > p_timestamp - interval '5 minutes'
      ) then
        insert into public.bus_events (bus_id, trip_id, event_type, occurred_at, metadata)
        values (v_bus_id, v_trip_id, 'route_deviation', p_timestamp,
                jsonb_build_object('distance_m', round(v_dist::numeric)));
        v_events := v_events || jsonb_build_array(
          jsonb_build_object('type','route_deviation','distance_m', round(v_dist::numeric)));
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', 'SUCCESS',
    'stored', true,
    'pos_inserted', true,
    'state_updated', v_state_updated,
    'bus_id', v_bus_id,
    'trip_id', v_trip_id,
    'device_id', p_device_id,
    'epoch', v_epoch,
    'seq', p_seq,
    'events', v_events
  );
end;
$$;

-- 4. Spatial & Active Position Queries
create or replace function public.get_nearby_buses(
  p_latitude double precision,
  p_longitude double precision,
  p_radius_meters double precision default 2000,
  p_limit integer default 10
) returns table (
  bus_id uuid,
  bus_number text,
  display_name text,
  latitude numeric,
  longitude numeric,
  speed numeric,
  heading numeric,
  status text,
  recorded_at timestamptz,
  distance_meters double precision
)
language sql
stable
set search_path = public, extensions
as $$
  with q as (select extensions.st_setsrid(extensions.st_makepoint(p_longitude, p_latitude), 4326)::extensions.geography as pt)
  select b.id, b.bus_number::text, b.display_name::text, c.latitude::numeric, c.longitude::numeric,
         c.speed::numeric, c.heading::numeric, c.status::text, c.recorded_at,
         extensions.st_distance(c.location, q.pt) as distance_meters
    from public.bus_current_state c
    join public.buses b on b.id = c.bus_id, q
   where b.is_active
     and c.last_seen > now() - interval '2 minutes'
     and extensions.st_dwithin(c.location, q.pt, p_radius_meters)
   order by distance_meters asc
   limit least(greatest(p_limit, 1), 50);
$$;

create or replace function public.get_nearby_stops(
  p_latitude double precision,
  p_longitude double precision,
  p_radius_meters double precision default 500,
  p_limit integer default 10
) returns table (
  stop_id uuid,
  code text,
  name text,
  latitude numeric,
  longitude numeric,
  distance_meters double precision
)
language sql
stable
set search_path = public, extensions
as $$
  with q as (select extensions.st_setsrid(extensions.st_makepoint(p_longitude, p_latitude), 4326)::extensions.geography as pt)
  select s.id, s.code::text, s.name::text, s.latitude::numeric, s.longitude::numeric,
         extensions.st_distance(s.location, q.pt) as distance_meters
    from public.stops s, q
   where s.is_active
     and extensions.st_dwithin(s.location, q.pt, p_radius_meters)
   order by s.location <-> q.pt
   limit least(greatest(p_limit, 1), 50);
$$;

create or replace function public.get_active_bus_positions()
returns table (
  bus_id uuid,
  bus_number text,
  display_name text,
  device_id text,
  epoch bigint,
  seq bigint,
  latitude double precision,
  longitude double precision,
  speed double precision,
  heading double precision,
  accuracy double precision,
  status text,
  recorded_at timestamptz,
  last_seen timestamptz,
  freshness text
)
language sql
stable
set search_path = public, extensions
as $$
  select b.id as bus_id,
         b.bus_number::text,
         b.display_name::text,
         c.device_id,
         c.epoch,
         c.seq,
         c.latitude::double precision,
         c.longitude::double precision,
         c.speed::double precision,
         c.heading::double precision,
         c.accuracy::double precision,
         c.status::text,
         c.recorded_at,
         c.last_seen,
         case
           when c.last_seen >= now() - interval '90 seconds' then 'fresh'
           when c.last_seen >= now() - interval '15 minutes' then 'stale'
           else 'unavailable'
         end as freshness
    from public.bus_current_state c
    join public.buses b on b.id = c.bus_id
   where b.is_active = true;
$$;

-- Permissions
revoke all on function public.register_tracking_device(text,text,text,boolean) from public, anon, authenticated;
grant execute on function public.register_tracking_device(text,text,text,boolean) to service_role;

revoke all on function public.reset_device_sequence(text,text,text,text) from public, anon, authenticated;
grant execute on function public.reset_device_sequence(text,text,text,text) to service_role;

revoke all on function public.ingest_telemetry_packet(text,bigint,timestamptz,numeric,numeric,numeric,numeric,numeric,text,double precision,double precision,bigint) from public, anon, authenticated;
grant execute on function public.ingest_telemetry_packet(text,bigint,timestamptz,numeric,numeric,numeric,numeric,numeric,text,double precision,double precision,bigint) to service_role;

grant execute on function public.get_nearby_buses(double precision,double precision,double precision,integer) to service_role, authenticated;
grant execute on function public.get_nearby_stops(double precision,double precision,double precision,integer) to service_role, authenticated;
grant execute on function public.get_active_bus_positions() to service_role, authenticated;
