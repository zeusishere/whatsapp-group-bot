export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface AppConfig {
  app: {
    port: number;
    logLevel: LogLevel;
  };
  whatsapp: {
    authDir: string;
    botName: string;
    autoConnectOnBoot: boolean;
    printQrInTerminal: boolean;
    reconnect: {
      baseDelayMs: number;
      maxDelayMs: number;
    };
  };
  database: {
    path: string;
    maxMessagesPerGroup: number;
  };
  apiKey: string;
}

export const LOG_LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export const DEFAULT_CONFIG: AppConfig = {
  app: { port: 3000, logLevel: 'info' },
  whatsapp: {
    authDir: './auth_info_baileys',
    botName: 'Bot',
    autoConnectOnBoot: false,
    printQrInTerminal: true,
    reconnect: { baseDelayMs: 1000, maxDelayMs: 60000 },
  },
  database: { path: './data/bot.db', maxMessagesPerGroup: 3000 },
  apiKey: 'change-me',
};
