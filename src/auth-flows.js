export function signInWithEmailPassword(auth, email, password) {
  return auth.signInWithPassword({
    email: String(email ?? '').trim(),
    password,
  });
}

export function requestPasswordRecovery(auth, email, redirectTo) {
  return auth.resetPasswordForEmail(String(email ?? '').trim(), { redirectTo });
}

export function setRecoveredPassword(auth, password) {
  return auth.updateUser({ password });
}

export function hasPasswordRecoveryMarker(search = '', hash = '') {
  const queryParams = new URLSearchParams(String(search).replace(/^\?/, ''));
  const hashParams = new URLSearchParams(String(hash).replace(/^#/, ''));
  return queryParams.get('type') === 'recovery' || hashParams.get('type') === 'recovery';
}
