import { createClient } from '@supabase/supabase-js';

const STAGING_SUPABASE_ORIGIN = 'https://qkdsuvmlutkatcqoewkh.supabase.co';

export function isStagingProjectUrl(value) {
  try {
    const parsed = new URL(String(value ?? '').trim());
    return parsed.origin === STAGING_SUPABASE_ORIGIN
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function isPublishableKey(value) {
  if (value.startsWith('sb_publishable_')) return true;
  const segments = value.split('.');
  if (segments.length !== 3) return false;

  try {
    const payload = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='));
    return JSON.parse(decoded).role === 'anon';
  } catch {
    return false;
  }
}

export function getSupabasePublicConfig(env = {}) {
  const url = String(env?.VITE_SUPABASE_URL ?? '').trim();
  const publishableKey = String(env?.VITE_SUPABASE_PUBLISHABLE_KEY ?? '').trim();
  if (!url || !publishableKey || url.includes('YOUR_PROJECT_REF')
    || publishableKey.includes('YOUR_PUBLISHABLE') || !isPublishableKey(publishableKey)) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }

  return { url, publishableKey };
}

export function createPortalClient(env = import.meta.env, clientFactory = createClient) {
  const config = getSupabasePublicConfig(env);
  if (!config) return null;

  return clientFactory(config.url, config.publishableKey, {
    auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
  });
}
