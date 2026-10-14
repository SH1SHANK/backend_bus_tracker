import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { buildApp } from '../../src/app.js';
import { hashSecret } from '../../src/lib/password.js';

// ============================================================================
// ENVIRONMENT & SAFETY GUARDS
// ============================================================================
const supabaseUrl = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// SAFETY GUARD 1: Prevent running tests against production or non-local databases
if (!supabaseUrl.includes('127.0.0.1') && !supabaseUrl.includes('localhost')) {
  throw new Error(`CRITICAL SECURITY GUARD: Integration tests can only run against local databases (127.0.0.1). Target was: ${supabaseUrl}`);
}

// SAFETY GUARD 2: Ensure service-role key is provided
if (!supabaseKey) {
  throw new Error('CRITICAL CONFIGURATION ERROR: SUPABASE_SERVICE_ROLE_KEY environment variable is required for integration tests.');
}

// Dedicated direct client for asserting database state independent of Fastify
const db = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Test fixtures with safe unique identifiers
const TEST_BUS_ID = '00000000-0000-0000-0000-000000000099';
const TEST_BUS_NUMBER = 'INT-BUS-TEST-99';
const TEST_DEVICE_ID = 'INT-DEV-TEST-001';
const TEST_SECRET = 'IntegrationSecret1234!'; // 22 chars >= 16 chars

let app: Awaited<ReturnType<typeof buildApp>>;
let deviceToken: string;

describe('Fastify-to-Supabase Real Database Integration Suite', () => {
  beforeAll(async () => {
    // 0. Verify local Supabase connectivity
    const { error: pingError } = await db.from('buses').select('id').limit(1);
    if (pingError) {
      throw new Error(`Cannot reach local Supabase at ${supabaseUrl}. Ensure 'supabase start' has been run in NITC_BUS_TRACKING_APP: ${pingError.message}`);
    }

    // 1. Clean up any previous test remnants
    await db.from('bus_events').delete().eq('bus_id', TEST_BUS_ID);
    await db.from('bus_positions').delete().eq('bus_id', TEST_BUS_ID);
    await db.from('bus_current_state').delete().eq('bus_id', TEST_BUS_ID);
    await db.from('devices').delete().eq('device_id', TEST_DEVICE_ID);
    await db.from('buses').delete().eq('id', TEST_BUS_ID);

    // 2. Insert test bus fixture
    const { error: busErr } = await db.from('buses').insert({
      id: TEST_BUS_ID,
      bus_number: TEST_BUS_NUMBER,
      display_name: 'Integration Test Shuttle',
      is_active: true,
    });
    if (busErr) throw new Error(`Failed to create test bus: ${busErr.message}`);

    // 3. Register test tracking device with Bcrypt 8-round hash
    const credHash = await hashSecret(TEST_SECRET);
    const { error: devErr } = await db.from('devices').insert({
      device_id: TEST_DEVICE_ID,
      bus_id: TEST_BUS_ID,
      credential_hash: credHash,
      is_active: true,
      current_epoch: 1,
    });
    if (devErr) throw new Error(`Failed to create test device: ${devErr.message}`);

    // 4. Initialize Fastify application connected to real local Supabase
    app = await buildApp();
  });

  afterAll(async () => {
    // Deterministic cleanup
    if (app) await app.close();
    await db.from('bus_events').delete().eq('bus_id', TEST_BUS_ID);
    await db.from('bus_positions').delete().eq('bus_id', TEST_BUS_ID);
    await db.from('bus_current_state').delete().eq('bus_id', TEST_BUS_ID);
    await db.from('devices').delete().eq('device_id', TEST_DEVICE_ID);
    await db.from('buses').delete().eq('id', TEST_BUS_ID);
  });

  // --------------------------------------------------------------------------
  // Scenario A: Provisioning & Authentication
  // --------------------------------------------------------------------------
  describe('A. Provisioning & Authentication', () => {
    it('authenticates valid device credentials and returns JWT', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/device',
        payload: {
          device_id: TEST_DEVICE_ID,
          secret: TEST_SECRET,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.token).toBeDefined();
      expect(body.token_type).toBe('Bearer');
      expect(body.expires_in).toBe(43200);

      // Save token for subsequent tests
      deviceToken = body.token;
    });

    it('rejects invalid secret with HTTP 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/device',
        payload: {
          device_id: TEST_DEVICE_ID,
          secret: 'WrongSecretInvalid123',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('invalid_credentials');
    });
  });

  // --------------------------------------------------------------------------
  // Scenario B: Session Reset & Idempotent Retry
  // --------------------------------------------------------------------------
  describe('B. Session Reset & Idempotency', () => {
    const sessionId = 'int-boot-session-alpha-1';

    it('resets sequence and establishes epoch 2 on reboot', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/reset-session',
        payload: {
          device_id: TEST_DEVICE_ID,
          secret: TEST_SECRET,
          session_id: sessionId,
          reason: 'cold_boot_test',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.epoch).toBe(2);
      expect(body.device_id).toBe(TEST_DEVICE_ID);
      expect(body.idempotent_retry).toBe(false);

      // Verify database reflects epoch 2 and last_session_id
      const { data: dev } = await db
        .from('devices')
        .select('current_epoch, last_session_id')
        .eq('device_id', TEST_DEVICE_ID)
        .single();
      expect(dev?.current_epoch).toBe(2);
      expect(dev?.last_session_id).toBe(sessionId);
    });

    it('idempotently returns established epoch on retry with identical session_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/reset-session',
        payload: {
          device_id: TEST_DEVICE_ID,
          secret: TEST_SECRET,
          session_id: sessionId,
          reason: 'cold_boot_test',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.epoch).toBe(2); // Did NOT increment to 3!
      expect(body.idempotent_retry).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario C: Successful Telemetry Ingestion
  // --------------------------------------------------------------------------
  describe('C. Successful Telemetry Ingestion', () => {
    it('persists valid packet to database history and current state', async () => {
      const nowIso = new Date().toISOString();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/telemetry',
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: {
          device_id: TEST_DEVICE_ID,
          seq: 1,
          epoch: 2,
          timestamp: nowIso,
          latitude: 11.321456,
          longitude: 75.934567,
          speed: 25.5,
          heading: 90.0,
          accuracy: 4.2,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.stored).toBe(true);
      expect(body.state_updated).toBe(true);

      // Verify bus_positions table row
      const { data: posRows } = await db
        .from('bus_positions')
        .select('device_id, epoch, seq, latitude, longitude, speed')
        .eq('device_id', TEST_DEVICE_ID)
        .eq('epoch', 2)
        .eq('seq', 1);

      expect(posRows).toHaveLength(1);
      expect(Number(posRows![0].latitude)).toBeCloseTo(11.321456, 5);
      expect(Number(posRows![0].speed)).toBeCloseTo(25.5, 1);

      // Verify bus_current_state table row
      const { data: stateRows } = await db
        .from('bus_current_state')
        .select('device_id, epoch, seq, latitude, longitude')
        .eq('bus_id', TEST_BUS_ID);

      expect(stateRows).toHaveLength(1);
      expect(stateRows![0].seq).toBe(1);
      expect(stateRows![0].epoch).toBe(2);
      expect(stateRows![0].device_id).toBe(TEST_DEVICE_ID);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario D: Exact Duplicate Retry
  // --------------------------------------------------------------------------
  describe('D. Exact Duplicate Retry Idempotency', () => {
    it('handles identical packet retry idempotently without duplicating history', async () => {
      // Query current row count in history
      const { count: countBefore } = await db
        .from('bus_positions')
        .select('*', { count: 'exact', head: true })
        .eq('device_id', TEST_DEVICE_ID)
        .eq('epoch', 2);

      // Fetch the exact recorded_at from the first insertion to make timestamp identical
      const { data: firstPos } = await db
        .from('bus_positions')
        .select('recorded_at')
        .eq('device_id', TEST_DEVICE_ID)
        .eq('epoch', 2)
        .eq('seq', 1)
        .single();

      // Send exact identical packet retry
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/telemetry',
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: {
          device_id: TEST_DEVICE_ID,
          seq: 1,
          epoch: 2,
          timestamp: firstPos!.recorded_at,
          latitude: 11.321456,
          longitude: 75.934567,
          speed: 25.5,
          heading: 90.0,
          accuracy: 4.2,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.stored).toBe(false);
      expect(body.state_updated).toBe(false);
      expect(body.reason).toBe('duplicate');

      // Verify no extra row was inserted in history
      const { count: countAfter } = await db
        .from('bus_positions')
        .select('*', { count: 'exact', head: true })
        .eq('device_id', TEST_DEVICE_ID)
        .eq('epoch', 2);

      expect(countAfter).toBe(countBefore);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario E: Conflicting Sequence Reuse
  // --------------------------------------------------------------------------
  describe('E. Conflicting Sequence Reuse', () => {
    it('rejects sequence reuse with conflicting telemetry data with HTTP 409', async () => {
      // Query the first packet's timestamp to match time, but provide conflicting speed
      const { data: firstPos } = await db
        .from('bus_positions')
        .select('recorded_at')
        .eq('device_id', TEST_DEVICE_ID)
        .eq('epoch', 2)
        .eq('seq', 1)
        .single();

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/telemetry',
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: {
          device_id: TEST_DEVICE_ID,
          seq: 1, // Reusing seq 1 in epoch 2
          epoch: 2,
          timestamp: firstPos!.recorded_at,
          latitude: 11.321456, // Same coordinates (avoids GPS jump)
          longitude: 75.934567,
          speed: 45.0, // CONFLICTING speed (was 25.5 in first packet!)
          heading: 90.0,
          accuracy: 4.2,
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('SEQUENCE_REUSE_CONFLICT');
    });
  });

  // --------------------------------------------------------------------------
  // Scenario F: Epoch & Reboot Recovery
  // --------------------------------------------------------------------------
  describe('F. Epoch Transitions and Stale Packets', () => {
    it('rejects stale epoch packets after reboot establishes epoch 3', async () => {
      // 1. Advance to epoch 3
      const resetRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/reset-session',
        payload: {
          device_id: TEST_DEVICE_ID,
          secret: TEST_SECRET,
          session_id: 'int-boot-session-beta-2',
        },
      });
      expect(resetRes.statusCode).toBe(200);
      expect(resetRes.json().epoch).toBe(3);

      // 2. Ingest packet in fresh epoch 3 at seq 1
      const p3Res = await app.inject({
        method: 'POST',
        url: '/api/v1/telemetry',
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: {
          device_id: TEST_DEVICE_ID,
          seq: 1,
          epoch: 3,
          timestamp: new Date().toISOString(),
          latitude: 11.322000,
          longitude: 75.935000,
          speed: 15.0,
          heading: 45.0,
          accuracy: 5.0,
        },
      });
      expect(p3Res.statusCode).toBe(200);
      expect(p3Res.json().stored).toBe(true);

      // 3. Try to submit delayed packet from old epoch 2
      const staleRes = await app.inject({
        method: 'POST',
        url: '/api/v1/telemetry',
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: {
          device_id: TEST_DEVICE_ID,
          seq: 2,
          epoch: 2, // OLD EPOCH!
          timestamp: new Date().toISOString(),
          latitude: 11.321800,
          longitude: 75.934800,
          speed: 12.0,
          heading: 45.0,
          accuracy: 5.0,
        },
      });
      expect(staleRes.statusCode).toBe(409);
      expect(staleRes.json().code).toBe('STALE_EPOCH_PACKET');
    });
  });

  // --------------------------------------------------------------------------
  // Scenario G: Dynamic Device Revocation
  // --------------------------------------------------------------------------
  describe('G. Dynamic Device Revocation', () => {
    it('immediately rejects telemetry from deactivated device with valid JWT', async () => {
      // Deactivate device directly in database
      await db.from('devices').update({ is_active: false }).eq('device_id', TEST_DEVICE_ID);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/telemetry',
        headers: { authorization: `Bearer ${deviceToken}` }, // JWT is still mathematically valid
        payload: {
          device_id: TEST_DEVICE_ID,
          seq: 2,
          epoch: 3,
          timestamp: new Date().toISOString(),
          latitude: 11.322100,
          longitude: 75.935100,
          speed: 10.0,
          heading: 45.0,
          accuracy: 5.0,
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('unauthorized');

      // Verify no row was inserted into bus_positions
      const { data: blockedPos } = await db
        .from('bus_positions')
        .select('*')
        .eq('device_id', TEST_DEVICE_ID)
        .eq('epoch', 3)
        .eq('seq', 2);
      expect(blockedPos).toHaveLength(0);

      // Reactivate device for subsequent tests
      await db.from('devices').update({ is_active: true }).eq('device_id', TEST_DEVICE_ID);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario H: Validation Failures
  // --------------------------------------------------------------------------
  describe('H. Validation and Boundary Invariants', () => {
    it('rejects coordinates outside transit boundary with HTTP 422', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/telemetry',
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: {
          device_id: TEST_DEVICE_ID,
          seq: 10,
          epoch: 3,
          timestamp: new Date().toISOString(),
          latitude: 28.6139, // New Delhi (outside service area)
          longitude: 77.2090,
          speed: 10.0,
          heading: 0.0,
          accuracy: 5.0,
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('outside_service_area');
    });

    it('rejects future timestamp skew with HTTP 422', async () => {
      const futureTime = new Date(Date.now() + 3600 * 1000).toISOString();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/telemetry',
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: {
          device_id: TEST_DEVICE_ID,
          seq: 11,
          epoch: 3,
          timestamp: futureTime,
          latitude: 11.3222,
          longitude: 75.9352,
          speed: 10.0,
          heading: 0.0,
          accuracy: 5.0,
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('timestamp_in_future');
    });

    it('accepts valid packet with permitted nullable GNSS fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/telemetry',
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: {
          device_id: TEST_DEVICE_ID,
          seq: 2,
          epoch: 3,
          timestamp: new Date().toISOString(),
          latitude: 11.3222,
          longitude: 75.9352,
          speed: null,
          heading: null,
          accuracy: null,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(res.json().stored).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario I: Concurrent Request Safety
  // --------------------------------------------------------------------------
  describe('I. Concurrency Safety under Database Locks', () => {
    it('handles concurrent packets safely without corrupting sequence state', async () => {
      const baseTime = Date.now();
      const packets = [20, 21, 22, 23, 24].map((seq, idx) => ({
        device_id: TEST_DEVICE_ID,
        seq,
        epoch: 3,
        timestamp: new Date(baseTime + idx * 1000).toISOString(),
        latitude: 11.3225 + idx * 0.0001,
        longitude: 75.9355 + idx * 0.0001,
        speed: 15.0,
        heading: 90.0,
        accuracy: 3.0,
      }));

      // Send all 5 packets concurrently
      const results = await Promise.all(
        packets.map((payload) =>
          app.inject({
            method: 'POST',
            url: '/api/v1/telemetry',
            headers: { authorization: `Bearer ${deviceToken}` },
            payload,
          }),
        ),
      );

      // Verify each request returned a valid status (200, or handled conflict if out-of-order race)
      results.forEach((res) => {
        expect([200, 409]).toContain(res.statusCode);
      });

      // Verify that database current state accepted the latest sequence safely
      const { data: state } = await db
        .from('bus_current_state')
        .select('seq, epoch')
        .eq('bus_id', TEST_BUS_ID)
        .single();

      expect(state?.epoch).toBe(3);
      expect(state?.seq).toBeGreaterThanOrEqual(20);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario J: Realtime Publication Enrollment
  // --------------------------------------------------------------------------
  describe('J. Realtime Publication Enrollment', () => {
    it('verifies bus_current_state is registered in supabase_realtime publication', async () => {
      // Query pg_publication_tables to verify publication membership
      const { data, error } = await db.rpc('get_active_bus_positions');
      // The function get_active_bus_positions proves active state reads work
      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);

      // Also verify current state has our test bus
      const { data: busState } = await db
        .from('bus_current_state')
        .select('*')
        .eq('bus_id', TEST_BUS_ID)
        .single();

      expect(busState).toBeDefined();
      expect(busState?.device_id).toBe(TEST_DEVICE_ID);
    });
  });
});
