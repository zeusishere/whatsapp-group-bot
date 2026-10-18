import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { performance } from 'node:perf_hooks';
import { AppConfig } from '../../config/env.schema.js';
import { CodedError } from '../models/errors.js';

const TAVILY_URL = 'https://api.tavily.com/search';
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';
const MAX_QUERY_CHARS = 400;
const MAX_SNIPPET_CHARS = 800;

export interface WebSearchHit {
  title: string;
  url: string;
  content: string;
  score: number;
  extracted?: string;
}

export interface WebSearchOutcome {
  query: string;
  results: WebSearchHit[];
  latency_ms: number;
}

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
}

interface TavilyExtractResult {
  url?: unknown;
  raw_content?: unknown;
  content?: unknown;
}

/**
 * Tavily search used as a traced retrieval source (not a router tool). Failures throw
 * `CodedError`; the pipeline records an ERROR span and continues with empty results.
 */
@Injectable()
export class WebSearchService {
  private readonly cfg: AppConfig['webSearch'];

  constructor(config: ConfigService<AppConfig, true>) {
    this.cfg = config.get('webSearch', { infer: true });
  }

  get enabled(): boolean {
    return this.cfg.apiKey.length > 0;
  }

  get extractTopN(): number {
    return this.cfg.extractTopN;
  }

  selectExtractUrls(urls: string[]): string[] {
    return selectHttpsUrls(urls, this.cfg.extractTopN);
  }

  async search(query: string): Promise<WebSearchOutcome> {
    const q = query.trim().slice(0, MAX_QUERY_CHARS);
    if (!this.enabled) {
      return { query: q, results: [], latency_ms: 0 };
    }
    if (!q) {
      return { query: q, results: [], latency_ms: 0 };
    }

    const t0 = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const response = await fetch(TAVILY_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          api_key: this.cfg.apiKey,
          query: q,
          search_depth: 'basic',
          include_answer: false,
          max_results: this.cfg.maxResults,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new CodedError(
          'WEB_SEARCH_REJECTED',
          `Tavily HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
        );
      }
      const payload: unknown = await response.json();
      return {
        query: q,
        results: parseHits(payload, this.cfg.maxResults),
        latency_ms: Math.round(performance.now() - t0),
      };
    } catch (e) {
      if (e instanceof CodedError) throw e;
      if (controller.signal.aborted) {
        throw new CodedError('WEB_SEARCH_TIMEOUT', `Tavily timed out after ${this.cfg.timeoutMs}ms`, { cause: e });
      }
      throw new CodedError('WEB_SEARCH_UNAVAILABLE', `Tavily request failed: ${(e as Error)?.message ?? String(e)}`, {
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async extract(urls: string[]): Promise<Map<string, string>> {
    if (!this.enabled || this.cfg.extractTopN <= 0 || !urls.length) {
      return new Map();
    }
    const targetUrls = selectHttpsUrls(urls, this.cfg.extractTopN);
    if (!targetUrls.length) {
      return new Map();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.extractTimeoutMs);
    try {
      const response = await fetch(TAVILY_EXTRACT_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          api_key: this.cfg.apiKey,
          urls: targetUrls,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new CodedError(
          'WEB_FETCH_REJECTED',
          `Tavily extract HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
        );
      }
      const payload: unknown = await response.json();
      return parseExtract(payload, this.cfg.extractMaxChars);
    } catch (e) {
      if (e instanceof CodedError) throw e;
      if (controller.signal.aborted) {
        throw new CodedError('WEB_FETCH_TIMEOUT', `Tavily extract timed out after ${this.cfg.extractTimeoutMs}ms`, {
          cause: e,
        });
      }
      throw new CodedError(
        'WEB_FETCH_UNAVAILABLE',
        `Tavily extract failed: ${(e as Error)?.message ?? String(e)}`,
        { cause: e },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function selectHttpsUrls(urls: string[], topN: number): string[] {
  if (topN <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    if (typeof raw !== 'string') continue;
    const u = raw.trim();
    if (!/^https:\/\/\S+/i.test(u) || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= topN) break;
  }
  return out;
}

export function parseExtract(payload: unknown, maxChars: number): Map<string, string> {
  const out = new Map<string, string>();
  if (maxChars <= 0) return out;
  const raw = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as TavilyExtractResult;
    if (typeof r.url !== 'string' || !r.url.trim()) continue;
    const body =
      typeof r.raw_content === 'string' && r.raw_content.trim()
        ? r.raw_content.trim()
        : typeof r.content === 'string'
          ? r.content.trim()
          : '';
    if (!body) continue;
    out.set(r.url.trim(), body.slice(0, maxChars));
  }
  return out;
}

export function parseHits(payload: unknown, maxResults: number): WebSearchHit[] {
  const raw = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(raw)) return [];
  const hits: WebSearchHit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as TavilyResult;
    if (typeof r.url !== 'string' || !r.url.trim()) continue;
    if (typeof r.title !== 'string' && typeof r.content !== 'string') continue;
    hits.push({
      title: typeof r.title === 'string' ? r.title.trim().slice(0, 300) : r.url,
      url: r.url.trim(),
      content: typeof r.content === 'string' ? r.content.trim().slice(0, MAX_SNIPPET_CHARS) : '',
      score: typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : 0,
    });
    if (hits.length >= maxResults) break;
  }
  return hits;
}
