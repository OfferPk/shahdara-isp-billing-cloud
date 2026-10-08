export function usernameToAuthEmail(username) {
  const normalizedUsername = String(username ?? '').trim();
  return normalizedUsername ? `${normalizedUsername}@shahdara.local` : '';
}

export function isStaffUsername(username) {
  return String(username ?? '').trim().toLowerCase() === 'admin';
}

export async function signInWithUsernamePassword(auth, username, password) {
  const email = usernameToAuthEmail(username);
  if (!email) return { data: null, error: new Error('Username is required.') };
  return auth.signInWithPassword({ email, password });
}

export function loginModeFromHash(hash) {
  return String(hash ?? '').toLowerCase() === '#admin-login' ? 'admin' : 'customer';
}

export function loginModeToHash(mode) {
  return mode === 'admin' ? '#admin-login' : '#customer-login';
}

export async function authenticatePortalLogin({ auth, functions, mode, username, password }) {
  if (mode === 'admin') return signInWithUsernamePassword(auth, username, password);

  // The customer broker returns an opaque portal token only; never establish a browser Auth session.
  if (isStaffUsername(username)) {
    return { data: null, error: new Error('Staff accounts must use Admin / Staff Login.') };
  }
  if (!functions || typeof functions.invoke !== 'function') {
    return { data: null, error: new Error('Customer sign-in is temporarily unavailable.') };
  }

  const { data, error } = await functions.invoke('customer-login', {
    body: { username, password },
  });
  if (error) return { data: null, error };
  if (!/^[0-9a-f]{64}$/.test(String(data?.portal_token ?? ''))
      || typeof data?.expires_at !== 'string' || !Number.isFinite(Date.parse(data.expires_at))) {
    return { data: null, error: new Error('Customer sign-in did not return a valid portal session.') };
  }
  return { data, error: null };
}
