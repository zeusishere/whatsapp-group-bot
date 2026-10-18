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
  /** Gemini access. With no `apiKey` the conversational bot is disabled (ingestion keeps working). */
  llm: {
    apiKey: string;
    model: string;
    embeddingModel: string;
    temperature: number;
    requestTimeoutMs: number;
    /** Extra attempts for transient generation errors (timeouts, 429, 5xx). */
    maxRetries: number;
  };
  bot: {
    /** Candidates fetched per query from each retriever before fusion. */
    candidatePoolSize: number;
    /** Max chunks that survive filtering and are considered for the prompt. */
    retrievalTopK: number;
    /** Minimum cosine similarity for a chunk to count as relevant. */
    minSimilarity: number;
    /** Minimum fraction of query keywords a chunk must contain when it has no embedding. */
    minLexicalCoverage: number;
    contextTokenBudget: number;
    maxOutputTokens: number;
    recentHistoryTurns: number;
    maxInputChars: number;
    fallbackReply: string;
  };
  tracing: {
    redact: boolean;
    previewChars: number;
    maxFieldChars: number;
  };
  /** Tavily web search. Empty `apiKey` disables web / hybrid search (message search still works). */
  webSearch: {
    apiKey: string;
    maxResults: number;
    timeoutMs: number;
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
  llm: {
    apiKey: '',
    model: 'gemini-2.5-flash',
    embeddingModel: 'gemini-embedding-001',
    temperature: 0.2,
    requestTimeoutMs: 30_000,
    maxRetries: 1,
  },
  bot: {
    candidatePoolSize: 30,
    retrievalTopK: 8,
    minSimilarity: 0.6,
    minLexicalCoverage: 0.34,
    contextTokenBudget: 1500,
    maxOutputTokens: 512,
    recentHistoryTurns: 4,
    maxInputChars: 2000,
    fallbackReply:
      "I couldn't find enough relevant context in this chat to answer that reliably. Could you rephrase or add more detail?",
  },
  tracing: { redact: true, previewChars: 240, maxFieldChars: 4000 },
  webSearch: { apiKey: '', maxResults: 5, timeoutMs: 10_000 },
};
