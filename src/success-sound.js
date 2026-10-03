export function prepareSuccessSound(view = globalThis.window) {
  const AudioContextConstructor = view?.AudioContext ?? view?.webkitAudioContext;
  if (typeof AudioContextConstructor !== 'function') {
    return { play() {}, cancel() {} };
  }

  let context;
  try {
    context = new AudioContextConstructor();
  } catch {
    return { play() {}, cancel() {} };
  }

  let settled = false;
  let closed = false;
  let resumePromise = Promise.resolve();
  try {
    if (context.state !== 'running' && typeof context.resume === 'function') {
      // Resume synchronously from the user-initiated submit gesture. No sound is
      // produced until play() is called after the password update is confirmed.
      resumePromise = Promise.resolve(context.resume()).catch(() => null);
    }
  } catch {
    resumePromise = Promise.resolve(null);
  }

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      if (context.state !== 'closed' && typeof context.close === 'function') {
        Promise.resolve(context.close()).catch(() => {});
      }
    } catch {
      // Audio is optional; the visible and announced confirmation remains.
    }
  };

  const play = () => {
    if (settled) return;
    settled = true;
    void resumePromise.then(() => {
      if (context.state !== 'running') {
        close();
        return;
      }
      try {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const startAt = context.currentTime;
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(659.25, startAt);
        oscillator.frequency.setValueAtTime(830.61, startAt + 0.085);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(0.035, startAt + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.19);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = close;
        oscillator.start(startAt);
        oscillator.stop(startAt + 0.195);
      } catch {
        close();
      }
    });
  };

  const cancel = () => {
    if (settled) return;
    settled = true;
    close();
  };

  return { play, cancel };
}
