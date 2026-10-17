import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppConfig, DEFAULT_CONFIG, LOG_LEVELS, LogLevel, MIN_JWT_SECRET_LENGTH } from './env.schema.js';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validates the raw JSON content of env.json and merges it over the defaults.
 * Collects every problem and throws a single readable error.
 */
export function validateConfig(raw: unknown): AppConfig {
  const errors: string[] = [];
  if (!isObj(raw)) {
    throw new Error('env.json must contain a JSON object at the top level');
  }

  const section = (name: string): Obj => {
    const v = raw[name];
    if (v === undefined) return {};
    if (!isObj(v)) {
      errors.push(`"${name}" must be an object`);
      return {};
    }
    return v;
  };

  const pick = <T>(
    src: Obj,
    path: string,
    key: string,
    fallback: T,
    check: (v: unknown) => boolean,
    expected: string,
  ): T => {
    const v = src[key];
    if (v === undefined) return fallback;
    if (!check(v)) {
      errors.push(`"${path}.${key}" must be ${expected}`);
      return fallback;
    }
    return v as T;
  };

  const isStr = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  const isBool = (v: unknown) => typeof v === 'boolean';
  const isPosInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
  const isPort = (v: unknown) => Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536;

  const d = DEFAULT_CONFIG;
  const app = section('app');
  const wa = section('whatsapp');
  const rc = isObj(wa.reconnect) ? wa.reconnect : {};
  if (wa.reconnect !== undefined && !isObj(wa.reconnect)) {
    errors.push('"whatsapp.reconnect" must be an object');
  }
  const db = section('database');
  const au = section('auth');
  const llm = section('llm');
  const bot = section('bot');
  const tr = section('tracing');
  const isUnit = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1;
  const isTemp = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 2;
  const isRetries = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 5;
  const isApiKey = (v: unknown) => typeof v === 'string';
  const isNonNegInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

  const config: AppConfig = {
    app: {
      port: pick(app, 'app', 'port', d.app.port, isPort, 'an integer between 1 and 65535'),
      logLevel: pick<LogLevel>(
        app,
        'app',
        'logLevel',
        d.app.logLevel,
        (v) => LOG_LEVELS.includes(v as LogLevel),
        `one of: ${LOG_LEVELS.join(', ')}`,
      ),
    },
    whatsapp: {
      restoreOnBoot: pick(wa, 'whatsapp', 'restoreOnBoot', d.whatsapp.restoreOnBoot, isBool, 'a boolean'),
      restoreStaggerMs: pick(
        wa,
        'whatsapp',
        'restoreStaggerMs',
        d.whatsapp.restoreStaggerMs,
        isNonNegInt,
        'a non-negative integer',
      ),
      printQrInTerminal: pick(
        wa,
        'whatsapp',
        'printQrInTerminal',
        d.whatsapp.printQrInTerminal,
        isBool,
        'a boolean',
      ),
      maxSessionsPerUser: pick(
        wa,
        'whatsapp',
        'maxSessionsPerUser',
        d.whatsapp.maxSessionsPerUser,
        isPosInt,
        'a positive integer',
      ),
      heartbeatIntervalMs: pick(
        wa,
        'whatsapp',
        'heartbeatIntervalMs',
        d.whatsapp.heartbeatIntervalMs,
        isPosInt,
        'a positive integer',
      ),
      reconnect: {
        baseDelayMs: pick(
          rc,
          'whatsapp.reconnect',
          'baseDelayMs',
          d.whatsapp.reconnect.baseDelayMs,
          isPosInt,
          'a positive integer',
        ),
        maxDelayMs: pick(
          rc,
          'whatsapp.reconnect',
          'maxDelayMs',
          d.whatsapp.reconnect.maxDelayMs,
          isPosInt,
          'a positive integer',
        ),
      },
    },
    database: {
      path: pick(db, 'database', 'path', d.database.path, isStr, 'a non-empty string'),
      maxMessagesPerGroup: pick(
        db,
        'database',
        'maxMessagesPerGroup',
        d.database.maxMessagesPerGroup,
        isPosInt,
        'a positive integer',
      ),
    },
    auth: {
      jwtSecret: pick(
        au,
        'auth',
        'jwtSecret',
        d.auth.jwtSecret,
        (v) => typeof v === 'string' && v.length >= MIN_JWT_SECRET_LENGTH,
        `a string of at least ${MIN_JWT_SECRET_LENGTH} characters`,
      ),
      tokenTtlSeconds: pick(
        au,
        'auth',
        'tokenTtlSeconds',
        d.auth.tokenTtlSeconds,
        isPosInt,
        'a positive integer (seconds)',
      ),
      allowRegistration: pick(
        au,
        'auth',
        'allowRegistration',
        d.auth.allowRegistration,
        isBool,
        'a boolean',
      ),
    },
    llm: {
      apiKey: pick(llm, 'llm', 'apiKey', d.llm.apiKey, isApiKey, 'a string (empty disables the bot)'),
      model: pick(llm, 'llm', 'model', d.llm.model, isStr, 'a non-empty string'),
      embeddingModel: pick(llm, 'llm', 'embeddingModel', d.llm.embeddingModel, isStr, 'a non-empty string'),
      temperature: pick(llm, 'llm', 'temperature', d.llm.temperature, isTemp, 'a number between 0 and 2'),
      requestTimeoutMs: pick(llm, 'llm', 'requestTimeoutMs', d.llm.requestTimeoutMs, isPosInt, 'a positive integer'),
      maxRetries: pick(llm, 'llm', 'maxRetries', d.llm.maxRetries, isRetries, 'an integer between 0 and 5'),
    },
    bot: {
      candidatePoolSize: pick(bot, 'bot', 'candidatePoolSize', d.bot.candidatePoolSize, isPosInt, 'a positive integer'),
      retrievalTopK: pick(bot, 'bot', 'retrievalTopK', d.bot.retrievalTopK, isPosInt, 'a positive integer'),
      minSimilarity: pick(bot, 'bot', 'minSimilarity', d.bot.minSimilarity, isUnit, 'a number between 0 and 1'),
      minLexicalCoverage: pick(
        bot,
        'bot',
        'minLexicalCoverage',
        d.bot.minLexicalCoverage,
        isUnit,
        'a number between 0 and 1',
      ),
      contextTokenBudget: pick(bot, 'bot', 'contextTokenBudget', d.bot.contextTokenBudget, isPosInt, 'a positive integer'),
      maxOutputTokens: pick(bot, 'bot', 'maxOutputTokens', d.bot.maxOutputTokens, isPosInt, 'a positive integer'),
      recentHistoryTurns: pick(bot, 'bot', 'recentHistoryTurns', d.bot.recentHistoryTurns, isNonNegInt, 'a non-negative integer'),
      maxInputChars: pick(bot, 'bot', 'maxInputChars', d.bot.maxInputChars, isPosInt, 'a positive integer'),
      fallbackReply: pick(bot, 'bot', 'fallbackReply', d.bot.fallbackReply, isStr, 'a non-empty string'),
    },
    tracing: {
      redact: pick(tr, 'tracing', 'redact', d.tracing.redact, isBool, 'a boolean'),
      previewChars: pick(tr, 'tracing', 'previewChars', d.tracing.previewChars, isPosInt, 'a positive integer'),
      maxFieldChars: pick(tr, 'tracing', 'maxFieldChars', d.tracing.maxFieldChars, isPosInt, 'a positive integer'),
    },
  };

  if (au.jwtSecret === undefined) {
    errors.push(
      `"auth.jwtSecret" is required (at least ${MIN_JWT_SECRET_LENGTH} characters, e.g. \`openssl rand -hex 32\`)`,
    );
  }

  if (config.whatsapp.reconnect.maxDelayMs < config.whatsapp.reconnect.baseDelayMs) {
    errors.push('"whatsapp.reconnect.maxDelayMs" must be >= "baseDelayMs"');
  }

  if (errors.length) {
    throw new Error(`Invalid env.json:\n - ${errors.join('\n - ')}`);
  }
  return config;
}

/** Resolves the config file path (ENV_JSON_PATH overrides the default ./env.json). */
export function resolveConfigPath(): string {
  return resolve(process.env.ENV_JSON_PATH ?? 'env.json');
}

/** Loader used by Nest's ConfigModule. Fails fast if the file is missing or invalid. */
export function loadConfig(): AppConfig {
  const path = resolveConfigPath();
  if (!existsSync(path)) {
    throw new Error(
      `Config file not found at ${path}. Copy env.example.json to env.json (or set ENV_JSON_PATH).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Could not parse ${path}: ${(e as Error).message}`, { cause: e });
  }
  return validateConfig(parsed);
}
