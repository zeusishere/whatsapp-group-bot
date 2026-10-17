import { validateConfig } from './configuration';
import { DEFAULT_CONFIG } from './env.schema';

const SECRET = 'x'.repeat(32);
const auth = { jwtSecret: SECRET };

describe('validateConfig', () => {
  it('applies defaults when only the required secret is given', () => {
    expect(validateConfig({ auth })).toEqual({
      ...DEFAULT_CONFIG,
      auth: { ...DEFAULT_CONFIG.auth, jwtSecret: SECRET },
    });
  });

  it('merges provided values over defaults', () => {
    const cfg = validateConfig({
      app: { port: 4000 },
      whatsapp: { restoreOnBoot: false, reconnect: { baseDelayMs: 500 } },
      auth: { jwtSecret: SECRET, tokenTtlSeconds: 60, allowRegistration: true },
    });
    expect(cfg.app.port).toBe(4000);
    expect(cfg.app.logLevel).toBe('info');
    expect(cfg.whatsapp.restoreOnBoot).toBe(false);
    expect(cfg.whatsapp.reconnect).toEqual({ baseDelayMs: 500, maxDelayMs: 60000 });
    expect(cfg.auth).toEqual({ jwtSecret: SECRET, tokenTtlSeconds: 60, allowRegistration: true });
  });

  it('requires auth.jwtSecret', () => {
    expect(() => validateConfig({})).toThrow(/auth\.jwtSecret" is required/);
  });

  it('rejects a short jwtSecret', () => {
    expect(() => validateConfig({ auth: { jwtSecret: 'short' } })).toThrow(/at least 32 characters/);
  });

  it('reports every invalid field in one error', () => {
    expect(() =>
      validateConfig({
        app: { port: 'abc', logLevel: 'loud' },
        whatsapp: { restoreOnBoot: 'yes' },
        database: { maxMessagesPerGroup: 0 },
        auth: { jwtSecret: SECRET, tokenTtlSeconds: -1 },
      }),
    ).toThrow(/app\.port[\s\S]*app\.logLevel[\s\S]*restoreOnBoot[\s\S]*maxMessagesPerGroup[\s\S]*tokenTtlSeconds/);
  });

  it('rejects maxDelayMs lower than baseDelayMs', () => {
    expect(() =>
      validateConfig({ auth, whatsapp: { reconnect: { baseDelayMs: 5000, maxDelayMs: 1000 } } }),
    ).toThrow(/maxDelayMs/);
  });

  it('rejects non-object roots and sections', () => {
    expect(() => validateConfig([])).toThrow(/JSON object/);
    expect(() => validateConfig({ auth, app: 5 })).toThrow(/"app" must be an object/);
  });
});
