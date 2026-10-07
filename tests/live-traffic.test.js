import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendLiveTrafficSample,
  drawLiveTrafficGraph,
  formatLiveTrafficRate,
  LIVE_TRAFFIC_HISTORY_LIMIT,
  LIVE_TRAFFIC_POLL_INTERVAL_MS,
  normalizeLiveTrafficSample,
} from '../src/live-traffic.js';

test('live rates are validated, labeled in decimal Kbps/Mbps, and sampled at a two-second cadence', () => {
  assert.equal(LIVE_TRAFFIC_POLL_INTERVAL_MS, 2_000);
  assert.equal(formatLiveTrafficRate(900), '900 bps');
  assert.equal(formatLiveTrafficRate(12_500), '12.5 Kbps');
  assert.equal(formatLiveTrafficRate(4_500_000), '4.5 Mbps');
  assert.equal(normalizeLiveTrafficSample({ downloadBitsPerSecond: -1, uploadBitsPerSecond: 2 }), null);
  assert.equal(normalizeLiveTrafficSample({ downloadBitsPerSecond: 'NaN', uploadBitsPerSecond: 2 }), null);
  assert.equal(normalizeLiveTrafficSample({ downloadBitsPerSecond: 2, uploadBitsPerSecond: 3 }).source, 'routeros');
});

test('sample history stays bounded to the latest 60 samples and accepts only the demo marker explicitly', () => {
  let samples = [];
  for (let index = 0; index < LIVE_TRAFFIC_HISTORY_LIMIT + 5; index += 1) {
    samples = appendLiveTrafficSample(samples, {
      downloadBitsPerSecond: index * 1_000,
      uploadBitsPerSecond: index * 200,
      sampledAt: new Date(1_000 + index * 2_000).toISOString(),
      source: 'demo',
    });
  }
  assert.equal(samples.length, 60);
  assert.equal(samples[0].downloadBitsPerSecond, 5_000);
  assert.equal(samples.at(-1).source, 'demo');
  assert.equal(appendLiveTrafficSample(samples, { downloadBitsPerSecond: Infinity, uploadBitsPerSecond: 0 }), samples);
});

test('Canvas renderer draws both rate series, axes, and bounded DPR dimensions', () => {
  const calls = [];
  const context = Object.fromEntries(['setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fillText'].map((name) => [name, (...args) => calls.push([name, ...args])]));
  const canvas = { clientWidth: 600, clientHeight: 220, width: 0, height: 0, getContext: () => context };
  const samples = appendLiveTrafficSample([], { downloadBitsPerSecond: 4_000_000, uploadBitsPerSecond: 500_000 });
  assert.equal(drawLiveTrafficGraph(canvas, samples), true);
  assert.equal(canvas.width, 600);
  assert.equal(canvas.height, 220);
  assert.ok(calls.some(([name]) => name === 'lineTo'));
  assert.ok(calls.some(([name, text]) => name === 'fillText' && text === 'Now'));
});
