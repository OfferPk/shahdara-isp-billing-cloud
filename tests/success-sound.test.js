import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSuccessSound } from '../src/success-sound.js';

function fakeBrowser({ resumeSucceeds = true } = {}) {
  const state = { contexts: [], oscillators: [], closeCalls: 0, resumeCalls: 0 };
  class FakeAudioContext {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 1;
      this.destination = {};
      state.contexts.push(this);
    }
    resume() {
      state.resumeCalls += 1;
      if (!resumeSucceeds) return Promise.reject(new Error('autoplay blocked'));
      this.state = 'running';
      return Promise.resolve();
    }
    createOscillator() {
      const oscillator = {
        frequency: {
          events: [],
          setValueAtTime(value, time) { this.events.push([value, time]); },
        },
        connect() {},
        start(time) { this.startedAt = time; },
        stop(time) { this.stoppedAt = time; },
        onended: null,
      };
      state.oscillators.push(oscillator);
      return oscillator;
    }
    createGain() {
      return {
        gain: {
          events: [],
          setValueAtTime(value, time) { this.events.push(['set', value, time]); },
          exponentialRampToValueAtTime(value, time) { this.events.push(['ramp', value, time]); },
        },
        connect() {},
      };
    }
    close() {
      state.closeCalls += 1;
      this.state = 'closed';
      return Promise.resolve();
    }
  }
  return { view: { AudioContext: FakeAudioContext }, state };
}

test('success tone resumes in the submit gesture but remains silent until play is called', async () => {
  const { view, state } = fakeBrowser();
  const feedback = prepareSuccessSound(view);
  assert.equal(state.resumeCalls, 1, 'resume is requested synchronously while the user gesture is active');
  assert.equal(state.oscillators.length, 0, 'no audio plays while the save request is pending');

  feedback.play();
  feedback.play();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.oscillators.length, 1, 'a confirmed save gets one restrained chime');
  assert.deepEqual(state.oscillators[0].frequency.events.map(([value]) => value), [659.25, 830.61]);
  assert.ok(state.oscillators[0].stoppedAt - state.oscillators[0].startedAt < 0.2);
  state.oscillators[0].onended();
  assert.equal(state.closeCalls, 1);
});

test('failed saves can cancel the prepared tone without ever creating an oscillator', async () => {
  const { view, state } = fakeBrowser();
  const feedback = prepareSuccessSound(view);
  feedback.cancel();
  feedback.play();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.oscillators.length, 0);
  assert.equal(state.closeCalls, 1);
});

test('unsupported or browser-blocked audio degrades without throwing or blocking feedback', async () => {
  const unsupported = prepareSuccessSound({});
  assert.doesNotThrow(() => { unsupported.play(); unsupported.cancel(); });

  const { view, state } = fakeBrowser({ resumeSucceeds: false });
  const blocked = prepareSuccessSound(view);
  blocked.play();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.oscillators.length, 0);
  assert.equal(state.closeCalls, 1);
});
