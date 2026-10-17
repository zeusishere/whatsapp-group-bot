import { createHash } from 'node:crypto';

const STOPWORDS = new Set(
  (
    'a an and are as at be but by can could did do does for from had has have how i if in into is it its just may me my ' +
    'of on or our please so than that the their them then there these they this to us was we were what when where which ' +
    'who whom why will with would you your about tell know any anyone someone said say says'
  ).split(' '),
);

/** Lowercased word tokens (letters/digits of any script). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Content words of a query: stopwords and one-letter latin tokens carry no signal for BM25 and
 * would inflate "coverage". Non-latin single characters are kept (a single CJK character is a word).
 */
export function keywords(text: string): string[] {
  const out = new Set<string>();
  for (const t of tokenize(text)) {
    if (STOPWORDS.has(t)) continue;
    if (t.length < 2 && t.charCodeAt(0) < 128) continue;
    out.add(t);
  }
  return [...out];
}

/** Fraction of `terms` that occur in `text` (0 when there are no terms). */
export function lexicalCoverage(terms: string[], text: string): number {
  if (!terms.length) return 0;
  const words = new Set(tokenize(text));
  let hit = 0;
  for (const t of terms) if (words.has(t)) hit++;
  return hit / terms.length;
}

/**
 * Builds an FTS5 MATCH expression from user text. Every term is double-quoted (embedded quotes
 * doubled) so FTS operators, column filters and punctuation in a chat message are treated as
 * plain text and can never produce a syntax error or alter the query.
 */
export function toFtsQuery(terms: string[]): string | null {
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** Hash of the text with case, punctuation and spacing removed: equal hashes mean "the same message". */
export function dedupeKey(text: string): string {
  return createHash('sha1').update(tokenize(text).join(' ')).digest('hex');
}

/**
 * Cheap token estimate that works without a tokenizer round trip: ~4 chars per token for
 * latin text, ~1 token per character for other scripts. Deliberately conservative (rounds up).
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

/** Cuts `text` to at most `maxTokens` (by `estimateTokens`), on a word boundary when possible. */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let end = text.length;
  while (end > 0 && estimateTokens(text.slice(0, end)) > maxTokens) end = Math.floor(end * 0.9);
  const cut = text.slice(0, end);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > end * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}
