import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/env.schema.js';
import { ChatThread, Json, Message } from '../models/types.js';
import { DecisionEngine, FallbackCode, TurnContext } from '../services/decision-engine.service.js';
import { PromptAssembler } from '../services/prompt-assembler.service.js';
import { modelConfig } from '../services/prompts.js';
import { RetrievalService } from '../services/retrieval.service.js';
import { TraceCollector } from '../tracing/trace-collector.js';

export interface PipelineInput {
  thread: ChatThread;
  question: string;
  history: Pick<Message, 'role' | 'content'>[];
  /** WhatsApp id of the inbound message, used to exclude it from retrieval. */
  inbound_external_id: string | null;
  quoted_message_id: string | null;
  now?: number;
}

/**
 * Orchestrates one request -> reply cycle. Every branch is a traced span, so a developer can
 * reconstruct why a given reply was produced (or why the fallback was used) from the database
 * alone. The collector's `run()` / `finally` is what persists the graph if this throws.
 */
@Injectable()
export class ChatPipelineService {
  private readonly bot: AppConfig['bot'];

  constructor(
    private readonly decisions: DecisionEngine,
    private readonly retrieval: RetrievalService,
    private readonly assembler: PromptAssembler,
    config: ConfigService<AppConfig, true>,
  ) {
    this.bot = config.get('bot', { infer: true });
  }

  async execute(collector: TraceCollector, input: PipelineInput): Promise<void> {
    const now = input.now ?? Date.now();
    const ctx: TurnContext = {
      question: input.question,
      history: input.history,
      quoted_message_id: input.quoted_message_id,
      now,
    };

    const guard = await this.decisions.guardrail(collector, input.question);
    if (!guard.allowed) {
      await this.decisions.fallback(collector, guard.code as FallbackCode);
      return;
    }

    const rewritten = await this.decisions.rewriteQuery(collector, ctx);
    const decision = await this.decisions.route(collector, ctx);

    if (decision.route === 'out_of_scope') {
      await this.decisions.fallback(collector, 'OUT_OF_SCOPE');
      return;
    }

    const toolResults: { tool: string; result: Json }[] = [];
    if (decision.route === 'use_tool' && decision.tool) {
      const result = await this.decisions.executeTool(collector, decision.tool, decision.args, {
        device_session_id: input.thread.device_session_id,
        group_id: input.thread.chat_jid,
        now,
      });
      if (result !== null) toolResults.push({ tool: decision.tool, result });
    }

    const needsContext = decision.route === 'answer_from_context' || decision.route === 'use_tool';
    let retrievalPack: { log: ReturnType<TraceCollector['recordRetrieval']>; texts: Map<string, string>; senders: Map<string, string> } | null =
      null;

    if (needsContext) {
      retrievalPack = await this.retrieve(collector, input, rewritten, now);
      const relevant = retrievalPack.log.retrieved_chunks.filter((c) => c.drop_reason === null);
      if (!relevant.length) {
        // Edge case 1: empty or all-below-threshold retrieval. Never generate from nothing.
        const best = maxSimilarity(retrievalPack.log.retrieved_chunks);
        await this.decisions.lowConfidenceContext(collector, {
          candidates: retrievalPack.log.retrieved_chunks.length,
          best_similarity: best,
          min_similarity: this.bot.minSimilarity,
          drop_reasons: countDrops(retrievalPack.log.retrieved_chunks),
        });
        await this.decisions.fallback(collector, 'LOW_CONFIDENCE_CONTEXT');
        return;
      }
    }

    const assembled = await collector.span(
      'PROMPT_ASSEMBLY',
      {
        kind: decision.route === 'smalltalk' ? 'smalltalk' : 'answer',
        context_budget_tokens: this.bot.contextTokenBudget,
        max_chunks: this.bot.retrievalTopK,
        history_messages: input.history.length,
        tool_results: toolResults.length,
      },
      (span) => {
        const prompt = this.assembler.assemble({
          question: input.question,
          history: input.history,
          retrieval: retrievalPack,
          tool_results: toolResults,
          kind: decision.route === 'smalltalk' ? 'smalltalk' : 'answer',
          context_budget_tokens: this.bot.contextTokenBudget,
          max_chunks: this.bot.retrievalTopK,
        });
        span.setModelConfig(modelConfig('prompt-assembler', null, prompt.template));
        span.setOutcome({
          template: prompt.template,
          included_chunk_ids: prompt.included_chunk_ids,
          budget_dropped_chunk_ids: prompt.budget_dropped_chunk_ids,
          truncated_chunk_ids: prompt.truncated_chunk_ids,
          context_tokens: prompt.context_tokens,
          prompt_tokens_estimate: prompt.prompt_tokens_estimate,
        });
        span.setRationale(
          prompt.budget_dropped_chunk_ids.length
            ? `Admitted ${prompt.included_chunk_ids.length} chunk(s); dropped ${prompt.budget_dropped_chunk_ids.length} for the ${prompt.context_budget_tokens}-token budget.`
            : `Assembled the ${prompt.template.id} v${prompt.template.version} prompt with ${prompt.included_chunk_ids.length} chunk(s).`,
        );
        return prompt;
      },
    );

    const reply = await this.decisions.generate(collector, assembled);
    collector.setReply(reply);
  }

  /**
   * Runs hybrid retrieval as one CONTEXT_RETRIEVAL span and buffers the log (chunk fates are
   * finalized later by prompt assembly). A thread not bound to a group is treated as an empty
   * retrieval so the low-confidence path still fires.
   */
  private async retrieve(
    collector: TraceCollector,
    input: PipelineInput,
    rewritten: string[],
    now: number,
  ): Promise<{ log: ReturnType<TraceCollector['recordRetrieval']>; texts: Map<string, string>; senders: Map<string, string> }> {
    return collector.span(
      'CONTEXT_RETRIEVAL',
      {
        device_session_id: input.thread.device_session_id,
        group_id: input.thread.chat_jid,
        raw_query: input.question,
        rewritten_queries: rewritten,
      },
      async (span) => {
        if (!input.thread.device_session_id || !input.thread.chat_jid) {
          const log = collector.recordRetrieval(span.span_id, {
            raw_query: input.question,
            rewritten_queries: rewritten,
            search_strategy: 'BM25',
            retrieved_chunks: [],
            latency_ms: 0,
          });
          span.setOutcome({ search_strategy: 'BM25', notes: ['UNBOUND_THREAD'], candidates: 0, kept: 0, dropped: 0 });
          span.setRationale('The conversation thread is not bound to a WhatsApp group, so there is no corpus to search.');
          return { log, texts: new Map<string, string>(), senders: new Map<string, string>() };
        }

        const outcome = await this.retrieval.retrieve({
          device_session_id: input.thread.device_session_id,
          group_id: input.thread.chat_jid,
          raw_query: input.question,
          rewritten_queries: rewritten,
          exclude_message_ids: input.inbound_external_id ? [input.inbound_external_id] : [],
          quoted_message_id: input.quoted_message_id,
          now,
        });
        const log = collector.recordRetrieval(span.span_id, {
          raw_query: input.question,
          rewritten_queries: rewritten,
          search_strategy: outcome.search_strategy,
          retrieved_chunks: outcome.chunks,
          latency_ms: outcome.latency_ms,
        });
        const kept = outcome.chunks.filter((c) => c.drop_reason === null).length;
        span.setOutcome({
          search_strategy: outcome.search_strategy,
          notes: outcome.notes,
          candidates: outcome.chunks.length,
          kept,
          dropped: outcome.chunks.length - kept,
          drop_reasons: countDrops(outcome.chunks),
          latency_ms: outcome.latency_ms,
        });
        span.setRationale(
          outcome.notes.length
            ? `Searched with ${outcome.search_strategy}: ${outcome.notes.join('; ')}`
            : `Searched with ${outcome.search_strategy}; ${kept} of ${outcome.chunks.length} candidate(s) cleared filters.`,
        );
        return { log, texts: outcome.texts, senders: outcome.senders };
      },
    );
  }
}

function countDrops(chunks: { drop_reason: string | null }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of chunks) {
    if (c.drop_reason) counts[c.drop_reason] = (counts[c.drop_reason] ?? 0) + 1;
  }
  return counts;
}

function maxSimilarity(chunks: { similarity_score: number }[]): number | null {
  if (!chunks.length) return null;
  return chunks.reduce((m, c) => Math.max(m, c.similarity_score), 0);
}
