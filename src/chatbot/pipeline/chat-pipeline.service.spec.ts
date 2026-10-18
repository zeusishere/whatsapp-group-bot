import { LlmError, LlmRequest, LlmResponse } from '../llm/llm-client.js';
import { DecisionEngine } from '../services/decision-engine.service.js';
import { EmbeddingService } from '../services/embedding.service.js';
import { PromptAssembler } from '../services/prompt-assembler.service.js';
import { HeuristicReranker } from '../services/reranker.js';
import { RetrievalService } from '../services/retrieval.service.js';
import { ToolRegistry } from '../services/tool.registry.js';
import { WebSearchService } from '../services/web-search.service.js';
import { configService, jsonReply, openTestDb, StubEmbeddings, StubLlm, testConfig, textReply } from '../testing/harness.js';
import { TraceInspectorService } from '../inspector/trace-inspector.service.js';
import { ChatPipelineService } from './chat-pipeline.service.js';
import { ChatService } from './chat.service.js';

function build(opts?: { llm?: StubLlm; cfg?: ReturnType<typeof testConfig> }) {
  const cfg = opts?.cfg ?? testConfig();
  const h = openTestDb(cfg);
  const llm = opts?.llm ?? new StubLlm();
  const embeddings = new EmbeddingService(h.database, new StubEmbeddings(), h.messages);
  const retrieval = new RetrievalService(h.database, h.messages, embeddings, new HeuristicReranker(), h.trace, configService(cfg));
  const tools = new ToolRegistry(h.messages);
  const decisions = new DecisionEngine(llm, tools, configService(cfg));
  const assembler = new PromptAssembler();
  const web = new WebSearchService(configService(cfg));
  const pipeline = new ChatPipelineService(decisions, retrieval, assembler, web, configService(cfg), h.messages);
  const inspector = new TraceInspectorService(h.repo);
  return { ...h, llm, pipeline, inspector, cfg };
}

/** Routes JSON calls by which schema they asked for; generation returns `answer`. */
function scripted(llm: StubLlm, plan: { rewrite?: unknown; route?: unknown; answer?: string; malformedOnce?: boolean }) {
  let malformed = plan.malformedOnce ?? false;
  llm.handler = (req: LlmRequest): LlmResponse => {
    if (req.json) {
      if (malformed) {
        malformed = false;
        return textReply('this is not json {{{');
      }
      const schema = JSON.stringify(req.jsonSchema ?? {});
      if (schema.includes('rewritten') || schema.includes('"queries"')) {
        return jsonReply(plan.rewrite ?? { queries: ['launch date'] });
      }
      return jsonReply(
        plan.route ?? { route: 'answer_from_context', confidence: 0.9, rationale: 'Looks like a group question.' },
      );
    }
    return textReply(plan.answer ?? 'The launch is next Tuesday.');
  };
}

describe('ChatPipelineService', () => {
  it('happy path: retrieves context, generates a reply, records COMPLETED', async () => {
    const h = build();
    scripted(h.llm, { answer: 'Next Tuesday, as Alice said.' });
    h.insertMessage({ id: 'm1', text: 'We decided the launch date is next Tuesday', timestamp: 1_000 });

    const claim = h.trace.claim({
      session_id: h.thread.session_id,
      idempotency_key: 'happy',
      user_input_raw: 'when is the launch?',
      user_external_id: null,
    });
    if (!claim.created) throw new Error('expected create');
    const turn = await claim.collector.run((c) =>
      h.pipeline.execute(c, {
        thread: h.thread,
        question: 'when is the launch?',
        history: [],
        inbound_external_id: null,
        quoted_message_id: null,
      }),
    );

    expect(turn.status).toBe('COMPLETED');
    expect(turn.bot_reply_raw).toBe('Next Tuesday, as Alice said.');
    expect(turn.token_usage.total_tokens).toBeGreaterThan(0);
    const types = h.repo.getSpans(turn.turn_id).map((s) => s.step_type);
    expect(types).toEqual(expect.arrayContaining(['GUARDRAIL_CHECK', 'QUERY_REWRITE', 'INTENT_ROUTER', 'CONTEXT_RETRIEVAL', 'PROMPT_ASSEMBLY', 'LLM_GENERATION']));
    expect(types).not.toContain('FALLBACK_HANDLER');
    const logs = h.repo.getRetrievalLogs(turn.turn_id);
    expect(logs).toHaveLength(1);
    expect(logs[0].retrieved_chunks.some((c) => c.used_in_final_prompt)).toBe(true);
  });

  it('empty retrieval triggers LOW_CONFIDENCE_CONTEXT and FALLBACK_TRIGGERED, with no generation', async () => {
    const h = build();
    scripted(h.llm, {});
    const claim = h.trace.claim({
      session_id: h.thread.session_id,
      idempotency_key: 'empty',
      user_input_raw: 'what is the launch date',
      user_external_id: null,
    });
    if (!claim.created) throw new Error('expected create');
    const turn = await claim.collector.run((c) =>
      h.pipeline.execute(c, {
        thread: h.thread,
        question: 'what is the launch date',
        history: [],
        inbound_external_id: null,
        quoted_message_id: null,
      }),
    );
    expect(turn.status).toBe('FALLBACK_TRIGGERED');
    expect(turn.bot_reply_raw).toBe(h.cfg.bot.fallbackReply);
    const types = h.repo.getSpans(turn.turn_id).map((s) => s.step_type);
    expect(types).toContain('LOW_CONFIDENCE_CONTEXT');
    expect(types).toContain('FALLBACK_HANDLER');
    expect(types).not.toContain('LLM_GENERATION');
  });

  it('marks leftover chunks TOKEN_BUDGET_EXCEEDED when the context budget is tiny', async () => {
    const h = build({ cfg: testConfig({ bot: { ...testConfig().bot, contextTokenBudget: 20, retrievalTopK: 8, minLexicalCoverage: 0 } }) });
    scripted(h.llm, { answer: 'ok' });
    h.insertMessage({ id: 'm1', text: 'alpha ' + 'word '.repeat(40), timestamp: 1 });
    h.insertMessage({ id: 'm2', text: 'beta ' + 'word '.repeat(40), timestamp: 2 });

    const claim = h.trace.claim({
      session_id: h.thread.session_id,
      idempotency_key: 'budget',
      user_input_raw: 'word word word',
      user_external_id: null,
    });
    if (!claim.created) throw new Error('expected create');
    const turn = await claim.collector.run((c) =>
      h.pipeline.execute(c, {
        thread: h.thread,
        question: 'word word word',
        history: [],
        inbound_external_id: null,
        quoted_message_id: null,
      }),
    );
    expect(turn.status).toBe('COMPLETED');
    const chunks = h.repo.getRetrievalLogs(turn.turn_id)[0].retrieved_chunks;
    expect(chunks.some((c) => c.used_in_final_prompt)).toBe(true);
    expect(chunks.some((c) => c.drop_reason === 'TOKEN_BUDGET_EXCEEDED')).toBe(true);
  });

  it('records a RETRYING span then falls back when router JSON is malformed', async () => {
    const h = build();
    scripted(h.llm, { malformedOnce: true, route: { route: 'smalltalk', confidence: 0.9, rationale: 'hi' }, answer: 'Hey!' });
    const claim = h.trace.claim({
      session_id: h.thread.session_id,
      idempotency_key: 'malformed',
      user_input_raw: 'hello',
      user_external_id: null,
    });
    if (!claim.created) throw new Error('expected create');
    const turn = await claim.collector.run((c) =>
      h.pipeline.execute(c, {
        thread: h.thread,
        question: 'hello',
        history: [],
        inbound_external_id: null,
        quoted_message_id: null,
      }),
    );
    expect(['COMPLETED', 'FALLBACK_TRIGGERED']).toContain(turn.status);
    const router = h.repo.getSpans(turn.turn_id).filter((s) => s.step_type === 'QUERY_REWRITE' || s.step_type === 'INTENT_ROUTER');
    expect(router.some((s) => s.status === 'RETRYING')).toBe(true);
  });

  it('marks the turn FAILED and keeps prior spans when generation throws', async () => {
    const h = build();
    h.llm.handler = (req) => {
      if (req.json) {
        const schema = JSON.stringify(req.jsonSchema ?? {});
        if (schema.includes('"queries"')) return jsonReply({ queries: ['x'] });
        return jsonReply({ route: 'smalltalk', confidence: 0.9, rationale: 'greeting' });
      }
      throw new LlmError('LLM_UNAVAILABLE', 'boom', false);
    };
    const claim = h.trace.claim({
      session_id: h.thread.session_id,
      idempotency_key: 'failgen',
      user_input_raw: 'hi there',
      user_external_id: null,
    });
    if (!claim.created) throw new Error('expected create');
    const turn = await claim.collector.run((c) =>
      h.pipeline.execute(c, {
        thread: h.thread,
        question: 'hi there',
        history: [],
        inbound_external_id: null,
        quoted_message_id: null,
      }),
    );
    expect(turn.status).toBe('FAILED');
    expect(turn.error_details?.error_code).toBe('LLM_UNAVAILABLE');
    const spans = h.repo.getSpans(turn.turn_id);
    expect(spans.some((s) => s.step_type === 'GUARDRAIL_CHECK' && s.status === 'SUCCESS')).toBe(true);
    expect(spans.some((s) => s.step_type === 'LLM_GENERATION' && s.status === 'ERROR')).toBe(true);
    expect(turn.bot_reply_raw).toBeNull();
  });

  it('ChatService replays a completed turn on a duplicate Idempotency-Key', async () => {
    const h = build();
    scripted(h.llm, { route: { route: 'smalltalk', confidence: 0.9, rationale: 'hi' }, answer: 'Hello!' });
    const whatsapp = {
      setMentionHandler: () => undefined,
      sendAsSession: async () => ({ id: 'wa1', jid: h.groupId }),
    };
    const sessions = { findById: () => ({ ownerId: h.user.id }), requireAccessible: () => ({ id: h.deviceSessionId }) };
    const chat = new ChatService(
      h.llm,
      h.trace,
      h.repo,
      h.pipeline,
      sessions as never,
      whatsapp as never,
      configService(h.cfg),
    );

    const first = await chat.handleRest(h.user, { sessionId: h.thread.session_id, message: 'hello' }, 'abc');
    const second = await chat.handleRest(h.user, { sessionId: h.thread.session_id, message: 'hello' }, 'abc');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.turnId).toBe(first.turnId);
    expect(second.reply).toBe(first.reply);
    expect(h.repo.getSpans(first.turnId).filter((s) => s.step_type === 'LLM_GENERATION')).toHaveLength(1);
  });

  describe('web vs message vs hybrid search', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    function mockTavily(
      results: { title: string; url: string; content: string; score: number }[],
      extract?: Record<string, string> | 'fail',
    ) {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/extract')) {
          if (extract === 'fail') {
            return { ok: false, status: 502, json: async () => ({}), text: async () => 'bad gateway' };
          }
          const map = extract ?? {};
          return {
            ok: true,
            json: async () => ({
              results: Object.entries(map).map(([u, raw_content]) => ({ url: u, raw_content })),
            }),
            text: async () => '',
          };
        }
        return {
          ok: true,
          json: async () => ({ results }),
          text: async () => '',
        };
      }) as unknown as typeof fetch;
    }

    const webCfg = () => testConfig({ webSearch: { apiKey: 'tvly-test', maxResults: 5, timeoutMs: 10000 } });

    it('web-only skips message retrieval, extracts page text, and answers from Tavily', async () => {
      const h = build({ cfg: webCfg() });
      mockTavily(
        [{ title: 'Launch', url: 'https://example.com/launch', content: 'The launch is Tuesday.', score: 0.9 }],
        { 'https://example.com/launch': 'Detailed page body: The product launch is Tuesday at 10am UTC.' },
      );
      scripted(h.llm, {
        route: { route: 'answer_from_context', search_source: 'web', confidence: 0.9, rationale: 'public fact' },
        answer: 'Tuesday, according to the web.',
      });

      const claim = h.trace.claim({
        session_id: h.thread.session_id,
        idempotency_key: 'web-only',
        user_input_raw: 'when is the product launching?',
        user_external_id: null,
      });
      if (!claim.created) throw new Error('expected create');
      const turn = await claim.collector.run((c) =>
        h.pipeline.execute(c, {
          thread: h.thread,
          question: 'when is the product launching?',
          history: [],
          inbound_external_id: null,
          quoted_message_id: null,
        }),
      );

      expect(turn.status).toBe('COMPLETED');
      expect(turn.bot_reply_raw).toBe('Tuesday, according to the web.\n\nSources:\n[1] Launch - https://example.com/launch');
      const spans = h.repo.getSpans(turn.turn_id);
      const types = spans.map((s) => s.step_type);
      expect(types).toContain('WEB_SEARCH');
      expect(types).toContain('WEB_FETCH');
      expect(types.indexOf('WEB_SEARCH')).toBeLessThan(types.indexOf('WEB_FETCH'));
      expect(types.indexOf('WEB_FETCH')).toBeLessThan(types.indexOf('PROMPT_ASSEMBLY'));
      expect(types).not.toContain('CONTEXT_RETRIEVAL');
      expect(types).toContain('LLM_GENERATION');
      const genCall = h.llm.calls.find((c) => !c.json);
      expect(genCall?.prompt).toContain('Detailed page body: The product launch is Tuesday at 10am UTC.');
      expect(genCall?.prompt).not.toContain('The launch is Tuesday.');
    });

    it('degrades to search snippets when Tavily extract fails without failing the turn', async () => {
      const h = build({ cfg: webCfg() });
      mockTavily(
        [{ title: 'Launch', url: 'https://example.com/launch', content: 'Snippet: launch is Tuesday.', score: 0.9 }],
        'fail',
      );
      scripted(h.llm, {
        route: { route: 'answer_from_context', search_source: 'web', confidence: 0.9, rationale: 'public fact' },
        answer: 'Tuesday from snippet.',
      });

      const claim = h.trace.claim({
        session_id: h.thread.session_id,
        idempotency_key: 'web-extract-fail',
        user_input_raw: 'when is the product launching?',
        user_external_id: null,
      });
      if (!claim.created) throw new Error('expected create');
      const turn = await claim.collector.run((c) =>
        h.pipeline.execute(c, {
          thread: h.thread,
          question: 'when is the product launching?',
          history: [],
          inbound_external_id: null,
          quoted_message_id: null,
        }),
      );

      expect(turn.status).toBe('COMPLETED');
      expect(turn.bot_reply_raw).toBe('Tuesday from snippet.\n\nSources:\n[1] Launch - https://example.com/launch');
      const spans = h.repo.getSpans(turn.turn_id);
      const fetchSpan = spans.find((s) => s.step_type === 'WEB_FETCH');
      expect(fetchSpan?.status).toBe('ERROR');
      const genCall = h.llm.calls.find((c) => !c.json);
      expect(genCall?.prompt).toContain('Snippet: launch is Tuesday.');
    });

    it('hybrid generates when chat retrieval is empty but the web hits', async () => {
      const h = build({ cfg: webCfg() });
      mockTavily([{ title: 'Hours', url: 'https://example.com/hours', content: 'Open until 10pm.', score: 0.8 }]);
      scripted(h.llm, {
        route: { route: 'answer_from_context', search_source: 'hybrid', confidence: 0.9, rationale: 'place in chat plus hours' },
        answer: 'It is open until 10pm.',
      });

      const claim = h.trace.claim({
        session_id: h.thread.session_id,
        idempotency_key: 'hybrid-web',
        user_input_raw: 'is that restaurant still open?',
        user_external_id: null,
      });
      if (!claim.created) throw new Error('expected create');
      const turn = await claim.collector.run((c) =>
        h.pipeline.execute(c, {
          thread: h.thread,
          question: 'is that restaurant still open?',
          history: [],
          inbound_external_id: null,
          quoted_message_id: null,
        }),
      );

      expect(turn.status).toBe('COMPLETED');
      const types = h.repo.getSpans(turn.turn_id).map((s) => s.step_type);
      expect(types).toContain('CONTEXT_RETRIEVAL');
      expect(types).toContain('WEB_SEARCH');
      expect(types).toContain('LLM_GENERATION');
      expect(types).not.toContain('FALLBACK_HANDLER');
    });

    it('falls back when hybrid finds nothing in chat or on the web', async () => {
      const h = build({ cfg: webCfg() });
      mockTavily([]);
      scripted(h.llm, {
        route: { route: 'answer_from_context', search_source: 'hybrid', confidence: 0.9, rationale: 'needs both' },
      });

      const claim = h.trace.claim({
        session_id: h.thread.session_id,
        idempotency_key: 'hybrid-empty',
        user_input_raw: 'what is the secret code?',
        user_external_id: null,
      });
      if (!claim.created) throw new Error('expected create');
      const turn = await claim.collector.run((c) =>
        h.pipeline.execute(c, {
          thread: h.thread,
          question: 'what is the secret code?',
          history: [],
          inbound_external_id: null,
          quoted_message_id: null,
        }),
      );

      expect(turn.status).toBe('FALLBACK_TRIGGERED');
      const types = h.repo.getSpans(turn.turn_id).map((s) => s.step_type);
      expect(types).toContain('LOW_CONFIDENCE_CONTEXT');
      expect(types).not.toContain('LLM_GENERATION');
    });
  });

  it('ChatService.handleMention resolves member @mentions and passes mentions JIDs to WhatsApp', async () => {
    const h = build();
    h.insertMessage({
      id: 'm-vinay',
      senderId: '73684542824592@lid',
      senderName: 'Vinay Jampana',
      text: 'I will be late',
      timestamp: 1_000,
    });
    scripted(h.llm, {
      route: { route: 'smalltalk', search_source: 'none', confidence: 0.95, rationale: 'ping request' },
      answer: 'Hey Vinay, where are you right now?',
    });

    const sentDtos: unknown[] = [];
    const whatsapp = {
      setMentionHandler: () => undefined,
      sendAsSession: async (_sid: string, dto: unknown) => {
        sentDtos.push(dto);
        return { id: 'wa-out-1', jid: h.groupId };
      },
    };
    const sessions = {
      findById: () => ({ ownerId: h.user.id }),
      requireAccessible: () => ({ id: h.deviceSessionId }),
    };
    const chat = new ChatService(
      h.llm,
      h.trace,
      h.repo,
      h.pipeline,
      sessions as never,
      whatsapp as never,
      configService(h.cfg),
    );

    const inbound = h.insertMessage({
      id: 'm-in',
      senderId: '269341845127193@lid',
      senderName: 'Shubham',
      text: '@239071553126652 tag vinay and ask him where he is?',
      mentionedJids: ['239071553126652@lid'],
      timestamp: 2_000,
    });
    await chat.handleMention(h.deviceSessionId, inbound);

    expect(sentDtos).toHaveLength(1);
    expect(sentDtos[0]).toEqual({
      jid: h.groupId,
      text: 'Hey @73684542824592, where are you right now?',
      quotedMessageId: 'm-in',
      mentions: ['73684542824592@lid'],
    });
  });
});
