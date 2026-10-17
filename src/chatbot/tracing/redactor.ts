import { Json, JsonObject } from '../models/types.js';

export interface RedactorOptions {
  /** When false, masking is skipped (values are still normalized to JSON and truncated). */
  enabled: boolean;
  /** Strings longer than this are cut, so a pasted document cannot bloat the trace tables. */
  maxFieldChars: number;
}

interface Pattern {
  kind: string;
  re: RegExp;
  /** Optional extra check (e.g. Luhn) to cut false positives. Receives the matched text. */
  accept?: (match: string) => boolean;
  /** Replace only this capture group instead of the whole match. */
  group?: number;
}

/** Luhn checksum: separates real card numbers from arbitrary digit runs. */
function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Credentials. A chunk containing one of these must never reach the LLM prompt, so
 * `Redactor.containsSecret` (used for the POLICY_FILTERED drop reason) checks this list only.
 */
const SECRET_PATTERNS: Pattern[] = [
  { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: 'google_api_key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { kind: 'openai_key', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  {
    // "password: hunter22", "api_key=abc123..." -> mask only the value.
    kind: 'credential_assignment',
    re: /\b(?:api[_-]?key|secret|passw(?:or)?d|token|auth)\b\s*[:=]\s*["']?([^\s"',;]{6,})/gi,
    group: 1,
  },
  {
    kind: 'card_number',
    re: /\b(?:\d[ -]?){13,19}\b/g,
    accept: (m) => {
      const digits = m.replace(/\D/g, '');
      // Bare 13-digit runs are far more often epoch milliseconds than cards.
      const separated = /[ -]/.test(m);
      return digits.length >= 13 && digits.length <= 19 && (separated || digits.length >= 15) && luhn(digits);
    },
  },
];

/** Personal data. Masked in traces, but not a reason to hide a chunk from the model. */
const PII_PATTERNS: Pattern[] = [
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // WhatsApp phone JIDs carry the number before the '@'.
  { kind: 'phone', re: /\b\d{7,15}(?::\d+)?(?=@s\.whatsapp\.net)/g },
  // International format, or classic grouped formats. Bare digit runs are NOT matched (timestamps).
  { kind: 'phone', re: /(?<![\w+])\+\d[\d\s().-]{7,}\d\b/g },
  { kind: 'phone', re: /\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/g },
];

/** Object keys whose values are always masked, whatever they contain. */
const SENSITIVE_KEY =
  /(password|passwd|secret|api[_-]?key|apikey|authorization|cookie|private[_-]?key|credential|access[_-]?token|refresh[_-]?token|^token$|_token$)/i;

const MAX_DEPTH = 10;
const MAX_ARRAY_ITEMS = 200;

/**
 * Scrubs sensitive values out of anything that is about to be persisted in a trace.
 *
 * Why it exists: traces are a debugging copy of the conversation. Developers read them, they get
 * exported to dashboards, and they outlive the chat. Credentials and personal data that users
 * paste into a chat must not be duplicated there.
 *
 * The same pass also normalizes arbitrary values into plain JSON (errors, buffers, cycles,
 * bigints), so the repository can `JSON.stringify` the result without ever throwing.
 */
export class Redactor {
  constructor(private readonly opts: RedactorOptions) {}

  /** Deep-sanitizes any value into JSON. */
  sanitize(value: unknown): Json {
    return this.walk(value, 0, new WeakSet());
  }

  sanitizeObject(value: Record<string, unknown>): JsonObject {
    const out = this.sanitize(value);
    return typeof out === 'object' && out !== null && !Array.isArray(out) ? out : {};
  }

  /** Masks and truncates a single string. */
  sanitizeString(text: string): string {
    return this.truncate(this.opts.enabled ? this.mask(text) : text);
  }

  /** A preview of at most `maxChars`, masked first so a secret cannot be split by the cut. */
  preview(text: string, maxChars: number): string {
    const masked = this.opts.enabled ? this.mask(text) : text;
    const single = masked.replace(/\s+/g, ' ').trim();
    return single.length > maxChars ? `${single.slice(0, maxChars)}…` : single;
  }

  /** True when the text contains a credential (not merely PII). Used for POLICY_FILTERED. */
  containsSecret(text: string): boolean {
    return SECRET_PATTERNS.some((p) => this.matches(p, text));
  }

  // ---------------------------------------------------------------- internals

  private matches(p: Pattern, text: string): boolean {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      if (!p.accept || p.accept(m[0])) return true;
    }
    return false;
  }

  private mask(text: string): string {
    let out = text;
    for (const p of [...SECRET_PATTERNS, ...PII_PATTERNS]) {
      out = out.replace(p.re, (match: string, ...args: unknown[]) => {
        if (p.accept && !p.accept(match)) return match;
        const label = `[REDACTED:${p.kind}]`;
        if (p.group) {
          const captured = args[p.group - 1];
          return typeof captured === 'string' ? match.replace(captured, label) : label;
        }
        return label;
      });
    }
    return out;
  }

  private truncate(text: string): string {
    const max = this.opts.maxFieldChars;
    return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text;
  }

  private walk(value: unknown, depth: number, seen: WeakSet<object>): Json {
    if (value === null || value === undefined) return null;
    switch (typeof value) {
      case 'string':
        return this.sanitizeString(value);
      case 'number':
        return Number.isFinite(value) ? value : null;
      case 'boolean':
        return value;
      case 'bigint':
        return value.toString();
      case 'function':
      case 'symbol':
        return null;
    }

    const obj = value as object;
    if (depth >= MAX_DEPTH) return '[max depth]';
    if (seen.has(obj)) return '[circular]';

    if (obj instanceof Error) {
      return { name: obj.name, message: this.sanitizeString(obj.message) };
    }
    if (obj instanceof Uint8Array) return `[binary ${obj.byteLength} bytes]`;
    if (obj instanceof Date) return obj.toISOString();

    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const items = obj.slice(0, MAX_ARRAY_ITEMS).map((v) => this.walk(v, depth + 1, seen));
        if (obj.length > MAX_ARRAY_ITEMS) items.push(`[+${obj.length - MAX_ARRAY_ITEMS} more]`);
        return items;
      }
      const out: JsonObject = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        out[k] = this.opts.enabled && SENSITIVE_KEY.test(k) && v !== null ? '[REDACTED:sensitive_key]' : this.walk(v, depth + 1, seen);
      }
      return out;
    } finally {
      // Siblings may legitimately share a reference; only true ancestors count as cycles.
      seen.delete(obj);
    }
  }
}
