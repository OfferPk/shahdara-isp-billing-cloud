export interface PppoeSessionDto {
  sessionId: string; // MikroTik .id or session identifier
  username: string; // PPPoE subscriber username
  callerId: string; // Client MAC Address (e.g. 48:8F:5A:12:34:56)
  ipAddress: string; // Assigned framed IP address (e.g. 10.10.20.45)
  interfaceName: string; // Interface (e.g. <pppoe-user01>)
  uptime: string; // Formatted uptime (e.g. "2d 04h 15m 32s")
  uptimeSeconds: number; // Raw uptime in seconds
  bytesIn: bigint; // Download octets (64-bit safe)
  bytesOut: bigint; // Upload octets (64-bit safe)
  rateLimit?: string; // Rate profile (e.g. "10M/10M")
  status: 'Online' | 'Offline' | 'Unknown';
  lastPolledAt: string; // ISO 8601 timestamp
}

export interface RouterHealthDto {
  connected: boolean;
  routerHost: string;
  routerOsVersion?: string;
  cpuLoadPercent?: number;
  freeMemoryMb?: number;
  latencyMs: number;
  lastCheckedAt: string;
}

export interface IRouterAdapter {
  getActiveSessions(): Promise<PppoeSessionDto[]>;
  getRouterHealth(): Promise<RouterHealthDto>;
}
