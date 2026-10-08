import { config } from '../config.js';
import { supabase } from '../lib/supabase.js';
import type { LastState } from '../services/anomaly.js';
import type { NormalisedTelemetry } from '../services/processing.js';

export interface IngestResult {
  ok: boolean;
  reason?: string;
  stored?: boolean;
  state_updated?: boolean;
  bus_id?: string;
  trip_id?: string | null;
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

export async function ingestTelemetry(deviceId: string, busId: string, t: NormalisedTelemetry): Promise<IngestResult> {
  const { data, error } = await supabase.rpc('ingest_telemetry', {
    p_device_id: deviceId,
    p_bus_id: busId,
    p_seq: t.seq,
    p_recorded_at: t.recordedAt,
    p_latitude: t.latitude,
    p_longitude: t.longitude,
    p_speed: t.speed,
    p_heading: t.heading,
    p_accuracy: t.accuracy,
    p_status: t.status,
    p_stop_radius_m: config.telemetry.stopRadiusM,
    p_deviation_m: config.telemetry.routeDeviationM,
  });
  if (error) throw new Error(`ingest_telemetry: ${error.message}`);
  return data as IngestResult;
}
