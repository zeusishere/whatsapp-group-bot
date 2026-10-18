import { configService, testConfig } from '../testing/harness.js';
import { parseHits, WebSearchService } from './web-search.service.js';

describe('parseHits', () => {
  it('keeps titled results with a url and drops junk', () => {
    expect(
      parseHits(
        {
          results: [
            { title: 'A', url: 'https://a.example', content: 'alpha', score: 0.9 },
            { title: 'no url' },
            { url: 'https://b.example', content: 'beta' },
            null,
            'x',
          ],
        },
        5,
      ),
    ).toEqual([
      { title: 'A', url: 'https://a.example', content: 'alpha', score: 0.9 },
      { title: 'https://b.example', url: 'https://b.example', content: 'beta', score: 0 },
    ]);
  });

  it('caps at maxResults', () => {
    const results = [1, 2, 3].map((n) => ({ title: `t${n}`, url: `https://e/${n}`, content: 'c' }));
    expect(parseHits({ results }, 2)).toHaveLength(2);
  });
});

describe('WebSearchService', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns empty results when the api key is missing', async () => {
    const svc = new WebSearchService(configService(testConfig({ webSearch: { apiKey: '', maxResults: 5, timeoutMs: 1000 } })));
    expect(svc.enabled).toBe(false);
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return { ok: true, json: async () => ({ results: [] }), text: async () => '' };
    }) as unknown as typeof fetch;
    await expect(svc.search('weather')).resolves.toEqual({ query: 'weather', results: [], latency_ms: 0 });
    expect(called).toBe(false);
  });

  it('parses Tavily JSON', async () => {
    const svc = new WebSearchService(configService(testConfig({ webSearch: { apiKey: 'tvly-test', maxResults: 5, timeoutMs: 5000 } })));
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        results: [{ title: 'News', url: 'https://news.example', content: 'It rained.', score: 0.7 }],
      }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const out = await svc.search('weather today');
    expect(out.query).toBe('weather today');
    expect(out.results).toEqual([{ title: 'News', url: 'https://news.example', content: 'It rained.', score: 0.7 }]);
  });

  it('throws WEB_SEARCH_REJECTED on HTTP errors', async () => {
    const svc = new WebSearchService(configService(testConfig({ webSearch: { apiKey: 'tvly-test', maxResults: 5, timeoutMs: 5000 } })));
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'unauthorized',
    })) as unknown as typeof fetch;

    await expect(svc.search('x')).rejects.toMatchObject({ code: 'WEB_SEARCH_REJECTED' });
  });

  it('throws WEB_SEARCH_TIMEOUT when the abort signal fires', async () => {
    const svc = new WebSearchService(configService(testConfig({ webSearch: { apiKey: 'tvly-test', maxResults: 5, timeoutMs: 20 } })));
    globalThis.fetch = ((_, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })) as unknown as typeof fetch;

    await expect(svc.search('slow')).rejects.toMatchObject({ code: 'WEB_SEARCH_TIMEOUT' });
  });
});
