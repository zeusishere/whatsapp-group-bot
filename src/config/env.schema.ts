export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface AppConfig {
  app: {
    port: number;
    logLevel: LogLevel;
  };
  whatsapp: {
    /** Re-open every session whose desired state is "connected" when the app starts. */
    restoreOnBoot: boolean;
    /** Pause between restoring two sessions, so we don't open many sockets at once. */
    restoreStaggerMs: number;
    printQrInTerminal: boolean;
    maxSessionsPerUser: number;
    /** How often connected sessions get their `last_seen_at` refreshed. */
    heartbeatIntervalMs: number;
    reconnect: {
      baseDelayMs: number;
      maxDelayMs: number;
    };
  };
  database: {
    path: string;
    maxMessagesPerGroup: number;
  };
  auth: {
    /** HS256 signing secret, at least 32 characters. Required. */
    jwtSecret: string;
    tokenTtlSeconds: number;
    /** When false, only the very first user can self-register; admins create the rest. */
    allowRegistration: boolean;
  };
}

export const LOG_LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export const MIN_JWT_SECRET_LENGTH = 32;

export const DEFAULT_CONFIG: AppConfig = {
  app: { port: 3000, logLevel: 'info' },
  whatsapp: {
    restoreOnBoot: true,
    restoreStaggerMs: 1000,
    printQrInTerminal: false,
    maxSessionsPerUser: 5,
    heartbeatIntervalMs: 30_000,
    reconnect: { baseDelayMs: 1000, maxDelayMs: 60000 },
  },
  database: { path: './data/bot.db', maxMessagesPerGroup: 3000 },
  auth: { jwtSecret: '', tokenTtlSeconds: 3600, allowRegistration: false },
};
