import { generateMermaidTrace } from './mermaid';
import { TraceInspectorService } from './trace-inspector.service';
import { openTestDb } from '../testing/harness';
import { DecisionSpan, RetrievalLog } from '../models/types';

describe('TraceInspectorService + generateMermaidTrace', () => {
  it('builds a DAG, tree, timeline and escaped Mermaid flowchart', async () => {
    const h = openTestDb();
    const inspector = new TraceInspectorService(h.repo);
    const claim = h.trace.claim({
      session_id: h.thread.session_id,
      idempotency_key: 'viz',
      user_input_raw: 'say "hello" <script>',
      user_external_id: null,
    });
    if (!claim.created) throw new Error('expected create');

    const turn = await claim.collector.run(async (c) => {
      await c.span('GUARDRAIL_CHECK', {}, async () => {
        await c.span('QUERY_REWRITE', {}, async (span) => {
          span.setStatus('RETRYING');
          span.setOutcome({ malformed_output: 'nope' });
        });
      });
      await c.span('QUERY_REWRITE', {}, async () => undefined);
      await c.span('CONTEXT_RETRIEVAL', {}, async (span) => {
        c.recordRetrieval(span.span_id, {
          raw_query: 'say hello',
          rewritten_queries: ['hello'],
          search_strategy: 'BM25',
          retrieved_chunks: [
            {
              chunk_id: 'c1',
              doc_id: 'd1',
              similarity_score: 0.9,
              rerank_score: 0.8,
              content_preview: 'kept',
              metadata: {},
              used_in_final_prompt: true,
              drop_reason: null,
              scores: { cosine: 0.9, bm25: 1, lexical_coverage: 1, rrf: 0.01 },
            },
            {
              chunk_id: 'c2',
              doc_id: 'd2',
              similarity_score: 0.1,
              rerank_score: 0.1,
              content_preview: 'dropped',
              metadata: {},
              used_in_final_prompt: false,
              drop_reason: 'BELOW_THRESHOLD',
              scores: { cosine: 0.1, bm25: 0, lexical_coverage: 0, rrf: 0 },
            },
          ],
          latency_ms: 4,
        });
      });
      await c.span('PROMPT_ASSEMBLY', {}, () => undefined);
      c.setReply('Hello there');
    });

    const view = inspector.inspectTurn(turn.turn_id, h.user);
    expect(view.tree).toHaveLength(4); // guardrail(+child), rewrite, retrieval, assembly
    expect(view.dag.nodes.some((n) => n.kind === 'user_message')).toBe(true);
    expect(view.dag.nodes.some((n) => n.kind === 'bot_message')).toBe(true);
    expect(view.dag.edges.some((e) => e.kind === 'parent')).toBe(true);
    expect(view.dag.edges.some((e) => e.kind === 'retry' || e.kind === 'sequence')).toBe(true);
    expect(view.dag.edges.some((e) => e.kind === 'data')).toBe(true);
    expect(view.timeline[0].stage).toBe('User Input');
    const retrievalItem = view.timeline.find((t) => t.step_type === 'CONTEXT_RETRIEVAL');
    expect(retrievalItem?.kept_chunks).toHaveLength(1);
    expect(retrievalItem?.dropped_chunks).toHaveLength(1);

    expect(view.mermaid).toMatch(/^flowchart TD/);
    expect(view.mermaid).not.toContain('<script>');
    expect(view.mermaid).toContain('#quot;');
    expect(view.mermaid).toContain('kept=1 dropped=1');
    expect(view.mermaid).toMatch(/-\.->/);

    const other = { id: '99999999-9999-4999-8999-999999999999', email: 'x@y.z', role: 'user' as const };
    expect(() => inspector.inspectTurn(turn.turn_id, other)).toThrow(/not found/);
  });

  it('escapes brackets and quotes in labels', () => {
    const turn = {
      turn_id: 't',
      session_id: 's',
      idempotency_key: 'k',
      user_message_id: 'u',
      bot_message_id: 'b',
      user_input_raw: 'say "hi" [now]',
      bot_reply_raw: 'ok',
      status: 'COMPLETED' as const,
      total_latency_ms: 1,
      token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      error_details: null,
      created_at: 0,
      updated_at: 0,
    };
    const spans: DecisionSpan[] = [
      {
        span_id: '01SPAN',
        turn_id: 't',
        parent_span_id: null,
        sequence_order: 1,
        step_type: 'FALLBACK_HANDLER',
        input_state: {},
        decision_outcome: null,
        rationale: null,
        model_config: null,
        status: 'FALLBACK',
        started_at: 0,
        ended_at: 1,
        duration_ms: 1,
      },
    ];
    const mermaid = generateMermaidTrace({ turn, spans, retrievals: [] as RetrievalLog[] });
    expect(mermaid).not.toMatch(/\[now\]/);
    expect(mermaid).toContain('#quot;');
    expect(mermaid).toContain('FALLBACK_HANDLER FALLBACK');
  });
});
