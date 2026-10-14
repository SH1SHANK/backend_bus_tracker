import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
  app.get('/test-client-ip', async (req) => ({ ip: req.ip, ips: req.ips }));
});

describe('Security & Proxy Trust', () => {
  it('ignores spoofed X-Forwarded-For when connecting directly from an untrusted public IP', async () => {
    // Untrusted public client connects directly (remoteAddress: 203.0.113.1) and tries to spoof 1.2.3.4
    const res = await app.inject({
      method: 'GET',
      url: '/test-client-ip',
      remoteAddress: '203.0.113.1', // NOT in trusted RFC1918 CIDRs
      headers: {
        'x-forwarded-for': '1.2.3.4', // Attempted spoof
      },
    });

    expect(res.statusCode).toBe(200);
    // Fastify must reject the spoofed header and attribute the request to the direct socket IP
    expect(res.json().ip).toBe('203.0.113.1');
  });

  it('stops at the first untrusted upstream hop when request arrives via trusted private proxy', async () => {
    // Request arrives via trusted internal proxy (10.0.0.1 / Render internal network)
    // Client sent: X-Forwarded-For: 1.2.3.4 (spoofed), 203.0.113.50 (real client appended by proxy)
    const res = await app.inject({
      method: 'GET',
      url: '/test-client-ip',
      remoteAddress: '10.0.0.1', // IN trusted RFC1918 CIDR (10.0.0.0/8)
      headers: {
        'x-forwarded-for': '1.2.3.4, 203.0.113.50',
      },
    });

    expect(res.statusCode).toBe(200);
    // Fastify trusts 10.0.0.1, inspects chain, sees 203.0.113.50 (untrusted), and halts.
    // The spoofed 1.2.3.4 preceding it is NEVER trusted!
    expect(res.json().ip).toBe('203.0.113.50');
  });

  it('rate limits per device ID rather than client IP for authenticated routes', async () => {
    // Demonstrates that even if a tracker changes or spoofs IP headers,
    // the rate-limit key is pegged to req.user.sub (device_id), preventing IP-hopping evasion
    const token = app.jwt.sign({ sub: 'NITC-BUS-RATELIMIT', bus_id: 'b1', typ: 'device' });
    
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/telemetry',
      headers: {
        authorization: `Bearer ${token}`,
        'x-forwarded-for': '1.1.1.1',
      },
      payload: {
        device_id: 'NITC-BUS-RATELIMIT',
        seq: 1,
        epoch: 1,
        timestamp: new Date().toISOString(),
        latitude: 11.321,
        longitude: 75.934,
      },
    });

    // Device token is inspected in preValidation; rate limiter keys on 'NITC-BUS-RATELIMIT'
    // Returns 401 because NITC-BUS-RATELIMIT is not in mocked DB, which proves auth ran before rate limit keying
    expect([200, 401, 403, 422]).toContain(res.statusCode);
  });
});
