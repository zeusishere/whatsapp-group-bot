import { DecisionEngine, heuristicRoute, RouteDecision } from './decision-engine.service.js';
import { ToolRegistry } from './tool.registry.js';
import { configService, jsonReply, openTestDb, StubLlm, testConfig } from '../testing/harness.js';

describe('heuristicRoute', () => {
  it('maps datetime questions to the datetime tool with no retrieval', () => {
    const d = heuristicRoute("what's the time", null);
    expect(d).toMatchObject({ route: 'use_tool', search_source: 'none', tool: 'current_datetime' });
  });

  it('maps greetings to smalltalk', () => {
    expect(heuristicRoute('hello', null).search_source).toBe('none');
    expect(heuristicRoute('thanks!', null).route).toBe('smalltalk');
  });

  it('defaults to searching group messages', () => {
    const d = heuristicRoute('when is the launch?', null);
    expect(d).toMatchObject({ route: 'answer_from_context', search_source: 'messages' });
  });

  it('fetches a quoted message from the chat corpus', () => {
    const d = heuristicRoute('what about this?', 'mid-1');
    expect(d).toMatchObject({ route: 'use_tool', search_source: 'messages', tool: 'lookup_quoted_message' });
  });
});

describe('DecisionEngine.route', () => {
  async function routed(opts: { webKey?: string; payload: unknown }) {
    const cfg = testConfig({ webSearch: { apiKey: opts.webKey ?? '', maxResults: 5, timeoutMs: 1000 } });
    const h = openTestDb(cfg);
    const llm = new StubLlm();
    llm.handler = () => jsonReply(opts.payload);
    const decisions = new DecisionEngine(llm, new ToolRegistry(h.messages), configService(cfg));
    const claim = h.trace.claim({
      session_id: h.thread.session_id,
      idempotency_key: 'route',
      user_input_raw: 'q',
      user_external_id: null,
    });
    if (!claim.created) throw new Error('expected create');
    let decision!: RouteDecision;
    await claim.collector.run(async (c) => {
      decision = await decisions.route(c, { question: 'q', history: [], quoted_message_id: null, now: 0 });
    });
    return decision;
  }

  it('defaults a missing search_source to messages', async () => {
    const d = await routed({
      webKey: 'tvly',
      payload: { route: 'answer_from_context', confidence: 0.9, rationale: 'group question' },
    });
    expect(d.search_source).toBe('messages');
  });

  it('coerces smalltalk to none even if the model asked for the web', async () => {
    const d = await routed({
      webKey: 'tvly',
      payload: { route: 'smalltalk', search_source: 'web', confidence: 0.9, rationale: 'hi' },
    });
    expect(d).toMatchObject({ route: 'smalltalk', search_source: 'none' });
  });

  it('rejects answer_from_context with none and uses messages', async () => {
    const d = await routed({
      webKey: 'tvly',
      payload: { route: 'answer_from_context', search_source: 'none', confidence: 0.9, rationale: 'x' },
    });
    expect(d.search_source).toBe('messages');
  });

  it('degrades web/hybrid to messages when Tavily is not configured', async () => {
    const d = await routed({
      webKey: '',
      payload: { route: 'answer_from_context', search_source: 'web', confidence: 0.9, rationale: 'news' },
    });
    expect(d.search_source).toBe('messages');
    expect(d.rationale).toMatch(/web search is not configured/i);
  });
});
