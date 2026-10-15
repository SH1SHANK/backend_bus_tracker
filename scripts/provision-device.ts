// Usage: npm run provision-device -- <bus_number> <device_id> [display_name]
// Creates the bus (if missing) and a device with a fresh secret. Secret is shown ONCE.
import { randomBytes } from 'node:crypto';
import { supabase } from '../src/lib/supabase.js';
import { hashSecret } from '../src/lib/password.js';

const [busNumber, deviceId, displayName] = process.argv.slice(2);
if (!busNumber || !deviceId) {
  console.error('usage: provision-device <bus_number> <device_id> [display_name]');
  process.exit(1);
}

const { data: bus, error: busErr } = await supabase
  .from('buses')
  .upsert({ bus_number: busNumber, display_name: displayName ?? busNumber }, { onConflict: 'bus_number' })
  .select('id')
  .single();
if (busErr) throw busErr;

// Generate 32-character high-entropy secret (enforces >= 16 character invariant)
const secret = randomBytes(24).toString('base64url');
const { error } = await supabase.from('devices').upsert(
  {
    device_id: deviceId,
    bus_id: bus.id,
    credential_hash: await hashSecret(secret),
    is_active: true,
    current_epoch: 1,
    updated_at: new Date().toISOString(),
  },
  { onConflict: 'device_id' },
);
if (error) throw error;

console.log(`bus_id:    ${bus.id}\ndevice_id: ${deviceId}\nsecret:    ${secret}\n(store the secret in the ESP32 firmware; it cannot be recovered)`);
