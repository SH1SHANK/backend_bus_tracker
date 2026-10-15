-- Bus tracking schema: PostgreSQL + PostGIS + pgcrypto + Realtime (Supabase)
create extension if not exists postgis with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

-- ───────── core data ─────────
create table public.stops (
  id uuid primary key default gen_random_uuid(),
  code varchar not null unique,
  name varchar not null,
  latitude numeric(9,6) not null check (latitude between -90 and 90),
  longitude numeric(9,6) not null check (longitude between -180 and 180),
  location extensions.geography(Point, 4326) generated always as (
    extensions.st_setsrid(extensions.st_makepoint(longitude::float8, latitude::float8), 4326)::extensions.geography
  ) stored,
  nearest_node_id bigint,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stops_location_gix on public.stops using gist (location);

create table public.routes (
  id uuid primary key default gen_random_uuid(),
  name varchar not null,
  direction varchar not null default 'forward',
  -- optional road-following geometry; if null, a line through ordered stops is used
  path extensions.geography(LineString, 4326),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.route_stops (
  route_id uuid not null references public.routes(id) on delete cascade,
  stop_id uuid not null references public.stops(id) on delete restrict,
  sequence integer not null check (sequence >= 0),
  distance_from_start numeric,
  estimated_duration_sec integer,
  primary key (route_id, sequence)
);
create index route_stops_stop_idx on public.route_stops (stop_id);

create table public.buses (
  id uuid primary key default gen_random_uuid(),
  bus_number varchar not null unique,
  display_name varchar,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  device_id text not null unique,
  bus_id uuid not null references public.buses(id) on delete cascade,
  credential_hash text not null,
  is_active boolean not null default true,
  current_epoch bigint not null default 1 check (current_epoch >= 1),
  last_session_id text,
  last_seen timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index devices_bus_idx on public.devices (bus_id);
create unique index idx_devices_single_active_bus on public.devices (bus_id) where (is_active = true);

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  bus_id uuid not null references public.buses(id) on delete cascade,
  route_id uuid not null references public.routes(id) on delete restrict,
  status varchar not null default 'scheduled'
    check (status in ('scheduled','active','completed','cancelled')),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index trips_one_active_per_bus on public.trips (bus_id) where status = 'active';
create index trips_bus_idx on public.trips (bus_id, created_at desc);

-- ───────── telemetry ─────────
create table public.bus_positions (
  id bigserial primary key,
  bus_id uuid not null references public.buses(id) on delete cascade,
  trip_id uuid references public.trips(id) on delete set null,
  device_id text not null,
  epoch bigint not null default 1 check (epoch >= 1),
  seq bigint not null check (seq >= 0),
  latitude numeric(9,6) not null,
  longitude numeric(9,6) not null,
  location extensions.geography(Point, 4326) generated always as (
    extensions.st_setsrid(extensions.st_makepoint(longitude::float8, latitude::float8), 4326)::extensions.geography
  ) stored,
  speed numeric(6,1),
  heading numeric(4,1),
  accuracy numeric(7,1),
  status varchar not null default 'stationary'
    check (status in ('moving','stationary','delay')),
  recorded_at timestamptz not null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint uq_bus_positions_device_epoch_seq unique (device_id, epoch, seq)
);
create index bus_positions_trip_idx on public.bus_positions (trip_id, recorded_at);
create index bus_positions_bus_recorded_idx on public.bus_positions (bus_id, recorded_at desc);
create index bus_positions_location_gix on public.bus_positions using gist (location);
create index bus_positions_recorded_brin on public.bus_positions using brin (recorded_at);

create table public.bus_current_state (
  bus_id uuid primary key references public.buses(id) on delete cascade,
  trip_id uuid references public.trips(id) on delete set null,
  device_id text,
  epoch bigint not null default 1 check (epoch >= 1),
  seq bigint not null default 0 check (seq >= 0),
  latitude numeric(9,6) not null,
  longitude numeric(9,6) not null,
  location extensions.geography(Point, 4326) generated always as (
    extensions.st_setsrid(extensions.st_makepoint(longitude::float8, latitude::float8), 4326)::extensions.geography
  ) stored,
  speed numeric(6,1),
  heading numeric(4,1),
  accuracy numeric(7,1),
  status varchar not null default 'stationary'
    check (status in ('moving','stationary','delay')),
  recorded_at timestamptz not null,
  last_seen timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bus_current_state_location_gix on public.bus_current_state using gist (location);

create table public.bus_events (
  id uuid primary key default gen_random_uuid(),
  bus_id uuid not null references public.buses(id) on delete cascade,
  trip_id uuid references public.trips(id) on delete set null,
  stop_id uuid references public.stops(id) on delete set null,
  event_type varchar not null
    constraint bus_events_event_type_check
    check (event_type in ('arrived','departed','route_deviation','trip_started','trip_ended','device_sequence_reset')),
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bus_events_lookup_idx on public.bus_events (bus_id, trip_id, stop_id, occurred_at desc);
create index bus_events_trip_type_idx on public.bus_events (trip_id, event_type, occurred_at desc);

-- updated_at triggers
do $$ declare t text; begin
  foreach t in array array['stops','routes','buses','devices'] loop
    execute format('create trigger %1$s_updated_at before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ───────── Row Level Security ─────────
alter table public.stops             enable row level security;
alter table public.routes            enable row level security;
alter table public.route_stops       enable row level security;
alter table public.buses             enable row level security;
alter table public.devices           enable row level security;
alter table public.trips             enable row level security;
alter table public.bus_positions     enable row level security;
alter table public.bus_current_state enable row level security;
alter table public.bus_events        enable row level security;

do $$ declare t text; begin
  foreach t in array array['stops','routes','route_stops','buses','trips','bus_current_state','bus_events'] loop
    execute format('create policy "read_%1$s" on public.%1$I for select to authenticated using (true)', t);
  end loop;
end $$;

-- ───────── Realtime ─────────
alter publication supabase_realtime add table public.bus_current_state;
