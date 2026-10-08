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

export function isCustomerLoginFallbackError(error) {
  return error?.context?.status === 401;
}

export function loginModeFromHash(hash) {
  return String(hash ?? '').toLowerCase() === '#admin-login' ? 'admin' : 'customer';
}

export function loginModeToHash(mode) {
  return mode === 'admin' ? '#admin-login' : '#customer-login';
}

export async function authenticatePortalLogin({ auth, functions, mode, username, password }) {
  if (mode === 'admin') return signInWithUsernamePassword(auth, username, password);

  // Keep the reserved staff alias out of the customer broker and its legacy Auth fallback.
  if (isStaffUsername(username)) {
    return { data: null, error: new Error('Staff accounts must use Admin / Staff Login.') };
  }

  const { data, error } = await functions.invoke('customer-login', {
    body: { username, password },
  });
  if (error && isCustomerLoginFallbackError(error)) {
    return signInWithUsernamePassword(auth, username, password);
  }
  if (error) return { data: null, error };
  if (!data?.session?.access_token || !data?.session?.refresh_token) {
    return { data: null, error: new Error('Customer sign-in did not return a valid session.') };
  }

  const { error: sessionError } = await auth.setSession(data.session);
  if (sessionError) {
    await auth.signOut();
    return { data: null, error: sessionError };
  }
  return { data, error: null };
}
