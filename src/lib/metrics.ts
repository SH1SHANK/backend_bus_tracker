import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const telemetryTotal = new client.Counter({
  name: 'telemetry_packets_total',
  help: 'Telemetry packets by outcome',
  labelNames: ['result', 'reason'] as const,
  registers: [registry],
});

export const ingestLatency = new client.Histogram({
  name: 'telemetry_ingest_seconds',
  help: 'DB ingest latency',
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});
