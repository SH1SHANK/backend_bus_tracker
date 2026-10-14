import { config } from '../config.js';
import { supabase } from '../lib/supabase.js';
import type { LastState } from '../services/anomaly.js';
import type { NormalisedTelemetry } from '../services/processing.js';

export interface IngestResult {
  ok: boolean;
  code: string;
  error?: string;
  reason?: string;
  stored?: boolean;
  state_updated?: boolean;
  bus_id?: string;
  trip_id?: string | null;
  device_id?: string;
  epoch?: number;
  seq?: number;
  pos_inserted?: boolean;
  events?: unknown[];
}

export async function getLastState(busId: string): Promise<LastState | null> {
  const { data, error } = await supabase
    .from('bus_current_state')
    .select('seq, recorded_at, latitude, longitude')
    .eq('bus_id', busId)
    .maybeSingle();
  if (error) throw new Error(`getLastState: ${error.message}`);
  if (!data) return null;
  return {
    seq: Number(data.seq),
    recorded_at: data.recorded_at as string,
    latitude: Number(data.latitude),
    longitude: Number(data.longitude),
  };
}

export async function ingestTelemetry(
  deviceId: string,
  _busId: string,
  t: NormalisedTelemetry,
): Promise<IngestResult> {
  const { data, error } = await supabase.rpc('ingest_telemetry_packet', {
    p_device_id: deviceId,
    p_seq: t.seq,
    p_timestamp: t.recordedAt,
    p_latitude: t.latitude,
    p_longitude: t.longitude,
    p_speed: t.speed ?? null,
    p_heading: t.heading ?? null,
    p_accuracy: t.accuracy ?? null,
    p_status: t.status ?? null,
    p_stop_radius_m: config.telemetry.stopRadiusM,
    p_deviation_m: config.telemetry.routeDeviationM,
    p_epoch: t.epoch ?? null,
  });
  if (error) throw new Error(`ingest_telemetry_packet: ${error.message}`);
  return data as IngestResult;
}
