import { Redactor } from './redactor';

const r = new Redactor({ enabled: true, maxFieldChars: 40 });

describe('Redactor', () => {
  it('masks sensitive object keys without looking at their values', () => {
    const out = r.sanitizeObject({ password: 'hunter22', apiKey: 'AIza' + 'x'.repeat(35), ok: 'hello' });
    expect(out.password).toBe('[REDACTED:sensitive_key]');
    expect(out.apiKey).toBe('[REDACTED:sensitive_key]');
    expect(out.ok).toBe('hello');
  });

  it('masks emails, phones, JWTs, Google keys and Bearer tokens in strings', () => {
    const wide = new Redactor({ enabled: true, maxFieldChars: 4000 });
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFBPJxXGTD8';
    const text = wide.sanitizeString(`mail me@example.com call +1 202-555-0147 key AIza${'Y'.repeat(35)} ${jwt} Bearer abcdefghijklmnop`);
    expect(text).toContain('[REDACTED:email]');
    expect(text).toContain('[REDACTED:phone]');
    expect(text).toContain('[REDACTED:google_api_key]');
    expect(text).toContain('[REDACTED:jwt]');
    expect(text).toContain('[REDACTED:bearer_token]');
    expect(text).not.toContain('me@example.com');
  });

  it('masks Luhn-valid cards and leaves random digits alone', () => {
    expect(r.sanitizeString('pay with 4111 1111 1111 1111 please')).toContain('[REDACTED:card_number]');
    expect(r.sanitizeString('epoch 1712345678901')).toContain('1712345678901');
  });

  it('truncates oversized strings', () => {
    const out = r.sanitizeString('a'.repeat(80));
    expect(out.length).toBeLessThan(80);
    expect(out).toMatch(/truncated/);
  });

  it('containsSecret is true only for credentials, not mere PII', () => {
    expect(r.containsSecret(`AIza${'Z'.repeat(35)}`)).toBe(true);
    expect(r.containsSecret('write to jane@example.com')).toBe(false);
  });

  it('skips masking when disabled but still truncates', () => {
    const off = new Redactor({ enabled: false, maxFieldChars: 10 });
    expect(off.sanitizeString('me@example.com extra')).toMatch(/truncated/);
    expect(off.sanitizeString('short')).toBe('short');
  });

  it('handles cycles, errors and buffers without throwing', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const out = r.sanitize({ err: new Error('AIza' + 'x'.repeat(35)), bin: new Uint8Array(4), cycle });
    expect(out).toMatchObject({ err: { name: 'Error' }, bin: '[binary 4 bytes]', cycle: { self: '[circular]' } });
  });
});
