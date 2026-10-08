import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

// Service-role client: bypasses RLS. Server-side only.
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function unwrap<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T | null {
  if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.data;
}
