import { openTestDb } from '../testing/harness';

describe('TraceCollector', () => {
  it('nests parent_span_id and assigns a monotonic sequence_order', async () => {
    const { repo, trace, thread } = openTestDb();
    const claim = trace.claim({ session_id: thread.session_id, idempotency_key: 'k1', user_input_raw: 'hi', user_external_id: null });
    if (!claim.created) throw new Error('expected create');

    const turn = await claim.collector.run(async (c) => {
      await c.span('GUARDRAIL_CHECK', { a: 1 }, async () => {
        await c.span('QUERY_REWRITE', { b: 2 }, async () => 'ok');
      });
      c.setReply('hello');
    });

    expect(turn.status).toBe('COMPLETED');
    const spans = repo.getSpans(turn.turn_id);
    expect(spans.map((s) => s.step_type)).toEqual(['GUARDRAIL_CHECK', 'QUERY_REWRITE']);
    expect(spans[0].sequence_order).toBe(1);
    expect(spans[1].sequence_order).toBe(2);
    expect(spans[0].parent_span_id).toBeNull();
    expect(spans[1].parent_span_id).toBe(spans[0].span_id);
    expect(spans.every((s) => s.status === 'SUCCESS')).toBe(true);
  });

  it('flushes completed work and marks FAILED when a span throws', async () => {
    const { repo, trace, thread } = openTestDb();
    const claim = trace.claim({ session_id: thread.session_id, idempotency_key: 'k2', user_input_raw: 'hi', user_external_id: null });
    if (!claim.created) throw new Error('expected create');

    const boom = Object.assign(new Error('llm down'), { code: 'LLM_UNAVAILABLE' });
    const turn = await claim.collector.run(async (c) => {
      await c.span('QUERY_REWRITE', {}, async () => 'rewritten');
      await c.span('LLM_GENERATION', {}, async (span) => {
        c.recordRetrieval(span.span_id, {
          raw_query: 'hi',
          rewritten_queries: [],
          search_strategy: 'BM25',
          retrieved_chunks: [],
          latency_ms: 3,
        });
        throw boom;
      });
    });

    expect(turn.status).toBe('FAILED');
    expect(turn.bot_message_id).toBeNull();
    expect(turn.bot_reply_raw).toBeNull();
    expect(turn.error_details?.error_code).toBe('LLM_UNAVAILABLE');
    expect(turn.error_details?.failed_at_span_id).toBeTruthy();

    const spans = repo.getSpans(turn.turn_id);
    expect(spans).toHaveLength(2);
    expect(spans[0].status).toBe('SUCCESS');
    expect(spans[1].status).toBe('ERROR');
    expect(turn.error_details?.failed_at_span_id).toBe(spans[1].span_id);
    expect(repo.getRetrievalLogs(turn.turn_id)).toHaveLength(1);
  });

  it('force-closes a span that is still open when the turn ends', async () => {
    const { repo, trace, thread } = openTestDb();
    const claim = trace.claim({ session_id: thread.session_id, idempotency_key: 'k3', user_input_raw: 'hi', user_external_id: null });
    if (!claim.created) throw new Error('expected create');

    // Bypass span() and leave an open span by never awaiting a hanging promise... we call finalize
    // after starting a span whose body never returns. Using a deferred:
    let release!: () => void;
    const hang = new Promise<void>((r) => {
      release = r;
    });
    const running = claim.collector.run(async (c) => {
      await c.span('LLM_GENERATION', {}, () => hang);
    });
    // Give the span a tick to open, then finalize from the outside (as a timeout would).
    await new Promise((r) => setTimeout(r, 5));
    const finalized = await claim.collector.finalize();
    release();
    await running;

    expect(finalized.status).toBe('FAILED');
    const spans = repo.getSpans(finalized.turn_id);
    expect(spans).toHaveLength(1);
    expect(spans[0].status).toBe('ERROR');
    expect(spans[0].rationale).toMatch(/still open|did not complete/i);
  });

  it('returns the existing turn on a duplicate idempotency key without extra spans', async () => {
    const { repo, trace, thread } = openTestDb();
    const input = { session_id: thread.session_id, idempotency_key: 'same', user_input_raw: 'hi', user_external_id: null };
    const first = trace.claim(input);
    if (!first.created) throw new Error('expected create');
    await first.collector.run(async (c) => {
      await c.span('GUARDRAIL_CHECK', {}, () => undefined);
      c.setReply('ok');
    });

    const second = trace.claim(input);
    expect(second.created).toBe(false);
    expect(second.turn.turn_id).toBe(first.turn.turn_id);
    expect(second.turn.status).toBe('COMPLETED');
    expect(repo.getSpans(first.turn.turn_id)).toHaveLength(1);
    expect(repo.getMessagesForTurn(first.turn.turn_id).filter((m) => m.role === 'USER')).toHaveLength(1);
  });

  it('returns the in-flight turn when the key is claimed again before finalize', () => {
    const { trace, thread } = openTestDb();
    const input = { session_id: thread.session_id, idempotency_key: 'inflight', user_input_raw: 'hi', user_external_id: null };
    const first = trace.claim(input);
    const second = trace.claim(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.turn.status).toBe('IN_PROGRESS');
    expect(second.turn.turn_id).toBe(first.turn.turn_id);
  });
});
