import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { performance } from 'node:perf_hooks';
import { AppConfig } from '../../config/env.schema.js';
import { CodedError } from '../models/errors.js';

const TAVILY_URL = 'https://api.tavily.com/search';
const MAX_QUERY_CHARS = 400;
const MAX_SNIPPET_CHARS = 800;

export interface WebSearchHit {
  title: string;
  url: string;
  content: string;
  score: number;
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
