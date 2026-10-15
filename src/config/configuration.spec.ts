import { validateConfig } from './configuration';
import { DEFAULT_CONFIG } from './env.schema';

describe('validateConfig', () => {
  it('applies defaults for an empty object', () => {
    expect(validateConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it('merges provided values over defaults', () => {
    const cfg = validateConfig({
      app: { port: 4000 },
      whatsapp: { autoConnectOnBoot: true, reconnect: { baseDelayMs: 500 } },
      apiKey: 'secret',
    });
    expect(cfg.app.port).toBe(4000);
    expect(cfg.app.logLevel).toBe('info');
    expect(cfg.whatsapp.autoConnectOnBoot).toBe(true);
    expect(cfg.whatsapp.reconnect).toEqual({ baseDelayMs: 500, maxDelayMs: 60000 });
    expect(cfg.apiKey).toBe('secret');
  });

  it('reports every invalid field in one error', () => {
    expect(() =>
      validateConfig({
        app: { port: 'abc', logLevel: 'loud' },
        whatsapp: { autoConnectOnBoot: 'yes' },
        database: { maxMessagesPerGroup: 0 },
        apiKey: '',
      }),
    ).toThrow(/app\.port[\s\S]*app\.logLevel[\s\S]*autoConnectOnBoot[\s\S]*maxMessagesPerGroup[\s\S]*apiKey/);
  });

  it('rejects maxDelayMs lower than baseDelayMs', () => {
    expect(() =>
      validateConfig({ whatsapp: { reconnect: { baseDelayMs: 5000, maxDelayMs: 1000 } } }),
    ).toThrow(/maxDelayMs/);
  });

  it('rejects non-object roots and sections', () => {
    expect(() => validateConfig([])).toThrow(/JSON object/);
    expect(() => validateConfig({ app: 5 })).toThrow(/"app" must be an object/);
  });
});
