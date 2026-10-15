import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppConfig, DEFAULT_CONFIG, LOG_LEVELS, LogLevel } from './env.schema.js';

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
      authDir: pick(wa, 'whatsapp', 'authDir', d.whatsapp.authDir, isStr, 'a non-empty string'),
      botName: pick(wa, 'whatsapp', 'botName', d.whatsapp.botName, isStr, 'a non-empty string'),
      autoConnectOnBoot: pick(
        wa,
        'whatsapp',
        'autoConnectOnBoot',
        d.whatsapp.autoConnectOnBoot,
        isBool,
        'a boolean',
      ),
      printQrInTerminal: pick(
        wa,
        'whatsapp',
        'printQrInTerminal',
        d.whatsapp.printQrInTerminal,
        isBool,
        'a boolean',
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
    apiKey: pick(raw, '(root)', 'apiKey', d.apiKey, isStr, 'a non-empty string'),
  };

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
