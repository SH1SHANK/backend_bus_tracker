#!/usr/bin/env tsx
/**
 * Tracklet Telemetry Simulator CLI (Node.js / tsx)
 * Simulates ESP32 tracking hardware transmitting telemetry to Fastify API Gateway.
 *
 * Usage:
 *   npx tsx scripts/simulate-telemetry.ts [--mode=simulate|batch] [--route=R1|R2] [--points=5] [--speed=22] [--fault=...]
 *   npm run simulate -- --mode=batch --points=10
 *   npm run simulate -- --fault=gps_drift
 */

// Route R1 57 Waypoints
const ROUTE_R1: [number, number][] = [
  [75.937622401, 11.317139262],
  [75.937532083, 11.317165826],
  [75.937768504, 11.317949468],
  [75.937952383, 11.318586754],
  [75.936663378, 11.318821721],
  [75.936310197, 11.318524561],
  [75.936197, 11.318517631],
  [75.936102285, 11.318591555],
  [75.936111525, 11.318649309],
  [75.935779808, 11.318773073],
  [75.935682782, 11.318786934],
  [75.935581136, 11.318706079],
  [75.935423053, 11.31875516],
  [75.934940234, 11.318775951],
  [75.934533649, 11.318907629],
  [75.934533649, 11.319785483],
  [75.934529029, 11.320162036],
  [75.934505927, 11.320399981],
  [75.934522098, 11.320919762],
  [75.934508238, 11.321136916],
  [75.934949474, 11.321573532],
  [75.935434649, 11.322106724],
  [75.935560552, 11.322366614],
  [75.935980998, 11.322812472],
  [75.936269765, 11.322843659],
  [75.93660127, 11.32302385],
  [75.936962808, 11.323242158],
  [75.9371661, 11.323344959],
  [75.937283917, 11.323175164],
  [75.9371661, 11.323344959],
  [75.936962808, 11.323242158],
  [75.93660127, 11.32302385],
  [75.936269765, 11.322843659],
  [75.935980998, 11.322812472],
  [75.935560552, 11.322366614],
  [75.935434649, 11.322106724],
  [75.934949474, 11.321573532],
  [75.934508238, 11.321136916],
  [75.934522098, 11.320919762],
  [75.934505927, 11.320399981],
  [75.934529029, 11.320162036],
  [75.934533649, 11.319785483],
  [75.934533649, 11.318907629],
  [75.934940234, 11.318775951],
  [75.935423053, 11.31875516],
  [75.935581136, 11.318706079],
  [75.935682782, 11.318786934],
  [75.935779808, 11.318773073],
  [75.936111525, 11.318649309],
  [75.936102285, 11.318591555],
  [75.936197, 11.318517631],
  [75.936310197, 11.318524561],
  [75.936663378, 11.318821721],
  [75.937952383, 11.318586754],
  [75.937768504, 11.317949468],
  [75.937532083, 11.317165826],
  [75.937622401, 11.317139262],
];

// Route R2 55 Waypoints
const ROUTE_R2: [number, number][] = [
  [75.932509521, 11.31486636],
  [75.933270755, 11.315101074],
  [75.933879743, 11.315767154],
  [75.933578421, 11.316011383],
  [75.933473751, 11.31616363],
  [75.933505469, 11.316325393],
  [75.933920976, 11.316569622],
  [75.933505469, 11.317286451],
  [75.933522505, 11.317865765],
  [75.933414664, 11.318633343],
  [75.932209376, 11.318474752],
  [75.931188053, 11.318068761],
  [75.93083281, 11.318633343],
  [75.932095191, 11.319305767],
  [75.932095191, 11.319603917],
  [75.932019067, 11.319781538],
  [75.932653429, 11.319952816],
  [75.933674752, 11.321113699],
  [75.9340744, 11.321494316],
  [75.93451211, 11.32113273],
  [75.93545731, 11.322109647],
  [75.935568224, 11.322362847],
  [75.935971044, 11.322803728],
  [75.936278709, 11.322844962],
  [75.936532454, 11.322987693],
  [75.936973336, 11.323254125],
  [75.937179503, 11.323346108],
  [75.937300032, 11.323184346],
  [75.937179503, 11.323346108],
  [75.936973336, 11.323254125],
  [75.936532454, 11.322987693],
  [75.936278709, 11.322844962],
  [75.935971044, 11.322803728],
  [75.935568224, 11.322362847],
  [75.93545731, 11.322109647],
  [75.93451211, 11.32113273],
  [75.9340744, 11.321494316],
  [75.933674752, 11.321113699],
  [75.932653429, 11.319952816],
  [75.932019067, 11.319781538],
  [75.932095191, 11.319603917],
  [75.932095191, 11.319305767],
  [75.93083281, 11.318633343],
  [75.931188053, 11.318068761],
  [75.932209376, 11.318474752],
  [75.933414664, 11.318633343],
  [75.933522505, 11.317865765],
  [75.933505469, 11.317286451],
  [75.933920976, 11.316569622],
  [75.933505469, 11.316325393],
  [75.933473751, 11.31616363],
  [75.933578421, 11.316011383],
  [75.933879743, 11.315767154],
  [75.933270755, 11.315101074],
  [75.932509521, 11.31486636],
];

function getArg(flag: string, fallback: string): string {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.split('=')[1] : fallback;
}

const mode = getArg('mode', 'simulate');
const routeName = getArg('route', 'R1').toUpperCase();
const fault = getArg('fault', '');
const points = Math.min(20, Math.max(1, Number(getArg('points', '5'))));
const intervalSec = Number(getArg('interval', '2.0'));
const apiUrl = getArg('apiUrl', process.env.API_URL || 'http://localhost:3000');
const deviceId = getArg('deviceId', 'NITC-SIM-001');
const secret = getArg('secret', 'SimDeviceSecret123456!');
const coords = routeName === 'R2' ? ROUTE_R2 : ROUTE_R1;

console.log(`\n🚍 [Tracklet Telemetry Simulator CLI]`);
console.log(`-------------------------------------------------`);
console.log(`Mode:       ${mode}`);
console.log(`Route:      ${routeName} (${coords.length} waypoints)`);
console.log(`API URL:    ${apiUrl}`);
console.log(`Device ID:  ${deviceId}`);
console.log(`Points:     ${points}`);
console.log(`Fault:      ${fault || 'none'}`);
console.log(`-------------------------------------------------\n`);

async function main() {
  // 1. Session Reset (Cold boot or explicitly requested)
  console.log(`[1/3] Resetting session / Negotiating Epoch...`);
  const sessionId = `cli-boot-${Date.now()}`;
  const resetRes = await fetch(`${apiUrl}/api/v1/auth/reset-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: deviceId,
      secret,
      session_id: sessionId,
      reason: fault === 'reboot' ? 'cli_fault_reboot' : 'cli_cold_boot',
    }),
  });

  if (!resetRes.ok) {
    console.error(`❌ Session reset failed: HTTP ${resetRes.status}`, await resetRes.text());
    process.exit(1);
  }

  const resetJson = await resetRes.json();
  const epoch = resetJson.epoch;
  console.log(`✅ Session reset established: Epoch ${epoch}, starting seq at 1`);

  // 2. Obtain Device JWT
  console.log(`[2/3] Authenticating with Fastify API Gateway...`);
  const authRes = await fetch(`${apiUrl}/api/v1/auth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, secret }),
  });

  if (!authRes.ok) {
    console.error(`❌ Authentication failed: HTTP ${authRes.status}`, await authRes.text());
    process.exit(1);
  }

  const { token } = await authRes.json();
  console.log(`✅ Received Device JWT Bearer token`);

  // 3. Ingest Telemetry
  if (mode === 'batch') {
    console.log(`\n[3/3] Submitting offline batch (${points} buffered packets) to /api/v1/telemetry/batch...`);
    const packets = [];
    const now = Date.now();
    for (let i = 0; i < points; i++) {
      const coordIdx = (i * 2) % coords.length;
      const [lon, lat] = coords[coordIdx];
      packets.push({
        device_id: deviceId,
        seq: 1 + i,
        epoch,
        timestamp: new Date(now - (points - 1 - i) * intervalSec * 1000).toISOString(),
        latitude: lat,
        longitude: lon,
        speed: 20.0,
        heading: 45.0,
        accuracy: 4.0,
      });
    }

    const batchRes = await fetch(`${apiUrl}/api/v1/telemetry/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ device_id: deviceId, packets }),
    });
    const batchJson = await batchRes.json();
    console.log(`\nBatch Ingestion Result (HTTP ${batchRes.status}):`);
    console.log(JSON.stringify(batchJson, null, 2));
  } else {
    console.log(`\n[3/3] Emitting ${points} sequential fixes along Route ${routeName}...`);
    for (let i = 0; i < points; i++) {
      if (i > 0 && intervalSec > 0) {
        await new Promise((r) => setTimeout(r, intervalSec * 1000));
      }
      const coordIdx = (i * 3) % coords.length;
      let [lon, lat] = coords[coordIdx];
      let speed = 22.0;

      if (fault === 'gps_drift' && i === Math.floor(points / 2)) {
        lat += 0.0016; // Drift off route ~170m
        console.log(`⚠️ Injected fault: GPS drift (+170m off-route)`);
      } else if (fault === 'excessive_speed' && i === 1) {
        speed = 135.0; // Injected speed fault
        console.log(`⚠️ Injected fault: Excessive speed (${speed} km/h)`);
      }

      const packet = {
        device_id: deviceId,
        seq: 1 + i,
        epoch,
        timestamp: new Date().toISOString(),
        latitude: Math.round(lat * 1e6) / 1e6,
        longitude: Math.round(lon * 1e6) / 1e6,
        speed,
        heading: 45.0,
        accuracy: 4.0,
      };

      const res = await fetch(`${apiUrl}/api/v1/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(packet),
      });

      const resJson = await res.json().catch(() => ({}));
      const okIcon = res.status === 200 ? '✅' : '❌';
      console.log(
        `${okIcon} [Fix ${i + 1}/${points}] Seq ${packet.seq} | Lat ${packet.latitude}, Lon ${packet.longitude} | Speed ${packet.speed} km/h -> HTTP ${res.status} (${JSON.stringify(resJson)})`,
      );
    }
  }

  console.log(`\n🎉 Simulation cycle completed successfully.\n`);
}

main().catch((err) => {
  console.error(`💥 Fatal error:`, err);
  process.exit(1);
});
