const DEFAULT_ROUTER_HOST = '10.10.20.1';
const MAC_OUIS = ['48:8F:5A', 'A4:2B:B0', 'D8:3A:DD', '60:32:B1', '2C:C8:1B'];

function formatUptime(seconds) {
  let remaining = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
}

/** Synthetic, browser-safe RouterOS-shaped data; never connects to a router. */
export class MockRouterAdapter {
  constructor({ now = () => new Date(), host = DEFAULT_ROUTER_HOST, subscriberCount = 20 } = {}) {
    this.now = now;
    this.host = host;
    this.pollCount = 0;
    this.subscriberCount = Math.max(15, Math.min(20, Math.trunc(subscriberCount)));
    this.baseRows = Array.from({ length: this.subscriberCount }, (_, index) => {
      const serial = index + 1;
      const username = `shahdara_user_${String(serial).padStart(2, '0')}`;
      const oui = MAC_OUIS[index % MAC_OUIS.length];
      const macTail = [serial, (serial * 37) % 256, (serial * 73) % 256]
        .map((part) => part.toString(16).padStart(2, '0')).join(':');
      const uptimeSeconds = 2300 + ((serial * 7919) % 250000);
      return {
        sessionId: `*${(0xA100 + serial).toString(16)}`,
        username,
        callerId: `${oui}:${macTail}`,
        ipAddress: `10.10.20.${100 + serial}`,
        interfaceName: `<pppoe-${username}>`,
        uptime: formatUptime(uptimeSeconds),
        uptimeSeconds,
        bytesIn: BigInt(95_000_000 + serial * 13_750_000),
        bytesOut: BigInt(18_000_000 + serial * 4_250_000),
        rateLimit: serial % 3 === 0 ? '20M/5M' : '10M/3M',
        status: 'Online',
      };
    });
  }

  async getActiveSessions() {
    this.pollCount += 1;
    const timestamp = this.now().toISOString();
    return this.baseRows.map((row, index) => ({
      ...row,
      bytesIn: row.bytesIn + BigInt(this.pollCount * (index + 1) * 17321),
      bytesOut: row.bytesOut + BigInt(this.pollCount * (index + 1) * 7919),
      lastPolledAt: timestamp,
    }));
  }

  async getRouterHealth() {
    return {
      connected: true,
      routerHost: this.host,
      routerOsVersion: '7.16.2 (mock)',
      cpuLoadPercent: 12,
      freeMemoryMb: 184,
      latencyMs: 5,
      lastCheckedAt: this.now().toISOString(),
    };
  }
}

export const pppoeMockAdapterInternals = Object.freeze({ formatUptime });
