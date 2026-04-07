import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url) throw new Error('Missing SUPABASE_URL');
  if (!key) throw new Error('Missing SUPABASE_SERVICE_KEY');

  client = createClient(url, key, {
    global: {
      // CRITICAL: Tell Next.js to NEVER cache Supabase fetch calls.
      // Without this, Next.js Data Cache returns stale query results
      // even after new transactions are inserted.
      fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
    },
  });
  return client;
}

// Lazy proxy: methods are resolved on first call, not on import
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop: string | symbol) {
    const c = getClient() as unknown as Record<string | symbol, unknown>;
    const value = c[prop];
    return typeof value === 'function' ? value.bind(c) : value;
  },
});
