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
