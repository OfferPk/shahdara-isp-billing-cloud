export const LIVE_TRAFFIC_POLL_INTERVAL_MS = 2000;
export const LIVE_TRAFFIC_HISTORY_LIMIT = 60;

export function normalizeLiveTrafficSample(sample, now = new Date()) {
  const download = Number(sample?.downloadBitsPerSecond);
  const upload = Number(sample?.uploadBitsPerSecond);
  const sampledAt = typeof sample?.sampledAt === 'string' && Number.isFinite(Date.parse(sample.sampledAt))
    ? sample.sampledAt
    : (now instanceof Date ? now : new Date(now)).toISOString();
  if (!Number.isFinite(download) || download < 0 || download > 1e12
      || !Number.isFinite(upload) || upload < 0 || upload > 1e12) return null;
  return {
    downloadBitsPerSecond: download,
    uploadBitsPerSecond: upload,
    sampledAt,
    source: sample?.source === 'demo' ? 'demo' : 'routeros',
  };
}

export function appendLiveTrafficSample(samples = [], sample, limit = LIVE_TRAFFIC_HISTORY_LIMIT) {
  const normalized = normalizeLiveTrafficSample(sample);
  if (!normalized) return samples;
  const boundedLimit = Math.max(1, Math.min(LIVE_TRAFFIC_HISTORY_LIMIT, Math.trunc(Number(limit) || LIVE_TRAFFIC_HISTORY_LIMIT)));
  return [...samples, normalized].slice(-boundedLimit);
}

export function formatLiveTrafficRate(bitsPerSecond, locale = 'en-PK') {
  const value = Number(bitsPerSecond);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value >= 1_000_000) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value / 1_000_000)} Mbps`;
  }
  if (value >= 1_000) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1_000)} Kbps`;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)} bps`;
}

function drawSeries(context, values, { left, top, plotWidth, plotHeight, maximum, color }) {
  if (!values.length) return;
  context.beginPath();
  context.strokeStyle = color;
  context.lineWidth = 2.5;
  values.forEach((value, index) => {
    const x = left + (values.length < 2 ? plotWidth : index * plotWidth / (values.length - 1));
    const y = top + plotHeight - (Math.max(0, value) / maximum) * plotHeight;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
}

export function drawLiveTrafficGraph(canvas, samples = []) {
  if (!canvas || typeof canvas.getContext !== 'function') return false;
  const context = canvas.getContext('2d');
  if (!context) return false;
  const width = Math.max(280, Math.round(canvas.clientWidth || canvas.width || 720));
  const height = Math.max(160, Math.round(canvas.clientHeight || 220));
  const pixelRatio = Math.max(1, Math.min(3, Number(globalThis.devicePixelRatio) || 1));
  const pixelWidth = Math.round(width * pixelRatio);
  const pixelHeight = Math.round(height * pixelRatio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);

  const left = 44;
  const right = 12;
  const top = 12;
  const bottom = 28;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  if (plotWidth <= 0 || plotHeight <= 0) return false;

  const values = samples.flatMap((sample) => [
    Number(sample.downloadBitsPerSecond) || 0,
    Number(sample.uploadBitsPerSecond) || 0,
  ]);
  const maximum = Math.max(1_000_000, ...values) * 1.12;
  context.font = '11px system-ui, sans-serif';
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (let tick = 0; tick <= 3; tick += 1) {
    const y = top + (plotHeight * tick) / 3;
    const value = maximum * (1 - tick / 3);
    context.beginPath();
    context.strokeStyle = '#d8e4dd';
    context.lineWidth = 1;
    context.moveTo(left, y);
    context.lineTo(width - right, y);
    context.stroke();
    context.fillStyle = '#5b6f66';
    context.fillText(formatLiveTrafficRate(value), left - 7, y);
  }
  const downloads = samples.map((sample) => Number(sample.downloadBitsPerSecond) || 0);
  const uploads = samples.map((sample) => Number(sample.uploadBitsPerSecond) || 0);
  drawSeries(context, downloads, { left, top, plotWidth, plotHeight, maximum, color: '#16815b' });
  drawSeries(context, uploads, { left, top, plotWidth, plotHeight, maximum, color: '#3578c8' });
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillStyle = '#5b6f66';
  context.fillText(samples.length ? 'Older' : 'Waiting for samples', left, height - 7);
  context.textAlign = 'right';
  context.fillText('Now', width - right, height - 7);
  return true;
}
