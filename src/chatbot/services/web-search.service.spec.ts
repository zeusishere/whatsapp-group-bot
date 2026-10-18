import { configService, testConfig } from '../testing/harness.js';
import { parseExtract, parseHits, WebSearchService } from './web-search.service.js';

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

describe('parseExtract', () => {
  it('parses raw_content or content and truncates to maxChars', () => {
    const out = parseExtract(
      {
        results: [
          { url: 'https://a.example', raw_content: 'abcdef' },
          { url: 'https://b.example', content: '123456' },
          { url: 'https://empty.example', raw_content: '   ' },
          { raw_content: 'no url' },
          null,
        ],
      },
      4,
    );
    expect([...out.entries()]).toEqual([
      ['https://a.example', 'abcd'],
      ['https://b.example', '1234'],
    ]);
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

  describe('extract', () => {
    it('returns an empty map without fetching when extractTopN is 0', async () => {
      const svc = new WebSearchService(
        configService(testConfig({ webSearch: { apiKey: 'tvly-test', extractTopN: 0 } })),
      );
      let called = false;
      globalThis.fetch = (async () => {
        called = true;
        return { ok: true, json: async () => ({ results: [] }), text: async () => '' };
      }) as unknown as typeof fetch;

      const out = await svc.extract(['https://a.example']);
      expect(out.size).toBe(0);
      expect(called).toBe(false);
    });

    it('skips non-https URLs, dedupes, caps at extractTopN, and parses extracted text', async () => {
      const svc = new WebSearchService(
        configService(
          testConfig({
            webSearch: { apiKey: 'tvly-test', extractTopN: 2, extractMaxChars: 50, extractTimeoutMs: 5000 },
          }),
        ),
      );
      let sentUrls: string[] = [];
      globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { urls: string[] };
        sentUrls = body.urls;
        return {
          ok: true,
          json: async () => ({
            results: [
              { url: 'https://a.example', raw_content: 'Full page A' },
              { url: 'https://b.example', content: 'Full page B' },
            ],
          }),
          text: async () => '',
        };
      }) as unknown as typeof fetch;

      const out = await svc.extract([
        'http://insecure.example',
        'ftp://files.example',
        'https://a.example',
        'https://a.example',
        'https://b.example',
        'https://c.example',
      ]);
      expect(sentUrls).toEqual(['https://a.example', 'https://b.example']);
      expect(out.get('https://a.example')).toBe('Full page A');
      expect(out.get('https://b.example')).toBe('Full page B');
    });

    it('throws a coded timeout error when extract times out', async () => {
      const svc = new WebSearchService(
        configService(testConfig({ webSearch: { apiKey: 'tvly-test', extractTopN: 2, extractTimeoutMs: 20 } })),
      );
      globalThis.fetch = ((_, init?: RequestInit) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        })) as unknown as typeof fetch;

      await expect(svc.extract(['https://a.example'])).rejects.toMatchObject({ code: 'WEB_FETCH_TIMEOUT' });
    });
  });
});
