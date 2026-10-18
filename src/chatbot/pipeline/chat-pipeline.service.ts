import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { performance } from 'node:perf_hooks';
import { AppConfig } from '../../config/env.schema.js';
import { GroupMember, MessagesRepository } from '../../messages/messages.repository.js';
import { ChatThread, Json, Message } from '../models/types.js';
import { DecisionEngine, FallbackCode, TurnContext } from '../services/decision-engine.service.js';
import {
  expandMemberQueries,
  isMentionOrMemberQuery,
  resolveMentions,
} from '../services/mentions.js';
import { PromptAssembler } from '../services/prompt-assembler.service.js';
import { SearchSource, modelConfig } from '../services/prompts.js';
import { RetrievalService } from '../services/retrieval.service.js';
import { WebSearchHit, WebSearchOutcome, WebSearchService } from '../services/web-search.service.js';
import { TraceCollector } from '../tracing/trace-collector.js';

export interface PipelineInput {
  thread: ChatThread;
  question: string;
  history: Pick<Message, 'role' | 'content'>[];
  /** WhatsApp id of the inbound message, used to exclude it from retrieval. */
  inbound_external_id: string | null;
  quoted_message_id: string | null;
  /** Known group members (with @handle IDs) for mention resolution. */
  members?: GroupMember[];
  /** JIDs mentioned in the inbound message, if any. */
  inbound_mentioned_jids?: string[];
  now?: number;
}

type RetrievalPack = { log: ReturnType<TraceCollector['recordRetrieval']>; texts: Map<string, string>; senders: Map<string, string> };

/**
 * Orchestrates one request -> reply cycle. Every branch is a traced span, so a developer can
 * reconstruct why a given reply was produced (or why the fallback was used) from the database
 * alone. The collector's `run()` / `finally` is what persists the graph if this throws.
 */
@Injectable()
export class ChatPipelineService {
  private readonly bot: AppConfig['bot'];
  private readonly tracing: AppConfig['tracing'];

  constructor(
    private readonly decisions: DecisionEngine,
    private readonly retrieval: RetrievalService,
    private readonly assembler: PromptAssembler,
    private readonly web: WebSearchService,
    config: ConfigService<AppConfig, true>,
    @Optional() private readonly messages?: MessagesRepository,
  ) {
    this.bot = config.get('bot', { infer: true });
    this.tracing = config.get('tracing', { infer: true });
  }

  resolveThreadMembers(thread: ChatThread, provided?: GroupMember[]): GroupMember[] {
    if (provided) return provided;
    if (thread.device_session_id && thread.chat_jid && this.messages) {
      return this.messages.listGroupMembers(thread.device_session_id, thread.chat_jid);
    }
    return [];
  }

  async execute(collector: TraceCollector, input: PipelineInput): Promise<void> {
    const now = input.now ?? Date.now();
    const members = this.resolveThreadMembers(input.thread, input.members);
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

    const source = decision.search_source;
    const wantsMessages = source === 'messages' || source === 'hybrid';
    const wantsWeb = this.web.enabled && (source === 'web' || source === 'hybrid');

    let retrievalPack: RetrievalPack | null = null;
    let webHits: WebSearchHit[] = [];

    if (wantsMessages || wantsWeb) {
      const baseWebQuery = rewritten[0] || input.question;
      const messageQueries = expandMemberQueries(input.question, rewritten, members);
      if (wantsMessages) {
        retrievalPack = await this.retrieve(collector, input, messageQueries, now);
      }
      if (wantsWeb) {
        const webQuery =
          source === 'hybrid'
            ? buildHybridWebQuery(baseWebQuery, retrievalPack)
            : baseWebQuery;
        const web = await this.searchWeb(collector, webQuery);
        webHits = web.results;
      }

      const messageHits = retrievalPack?.log.retrieved_chunks.filter((c) => c.drop_reason === null).length ?? 0;
      const hasEvidence =
        (wantsMessages && (messageHits > 0 || isMentionOrMemberQuery(input.question, members))) ||
        (wantsWeb && webHits.length > 0);
      if (!hasEvidence) {
        const chunks = retrievalPack?.log.retrieved_chunks ?? [];
        await this.decisions.lowConfidenceContext(collector, {
          candidates: chunks.length,
          best_similarity: maxSimilarity(chunks),
          min_similarity: this.bot.minSimilarity,
          drop_reasons: countDrops(chunks),
          search_source: source,
          web_results: webHits.length,
        });
        await this.decisions.fallback(collector, 'LOW_CONFIDENCE_CONTEXT');
        return;
      }

      if (this.web.extractTopN > 0 && webHits.length > 0) {
        webHits = await this.fetchPages(collector, webHits);
      }
    }

    const promptKind = decision.route === 'smalltalk' || decision.route === 'clarify' ? 'smalltalk' : 'answer';
    const assembled = await collector.span(
      'PROMPT_ASSEMBLY',
      {
        kind: promptKind,
        search_source: source,
        context_budget_tokens: this.bot.contextTokenBudget,
        max_chunks: this.bot.retrievalTopK,
        history_messages: input.history.length,
        tool_results: toolResults.length,
        web_results: webHits.length,
      },
      (span) => {
        const prompt = this.assembler.assemble({
          question: input.question,
          history: input.history,
          retrieval: retrievalPack,
          web_results: webHits,
          tool_results: toolResults,
          members,
          kind: promptKind,
          context_budget_tokens: this.bot.contextTokenBudget,
          max_chunks: this.bot.retrievalTopK,
        });
        span.setModelConfig(modelConfig('prompt-assembler', null, prompt.template));
        span.setOutcome({
          template: prompt.template,
          included_chunk_ids: prompt.included_chunk_ids,
          budget_dropped_chunk_ids: prompt.budget_dropped_chunk_ids,
          truncated_chunk_ids: prompt.truncated_chunk_ids,
          web_result_count: prompt.web_result_count,
          context_tokens: prompt.context_tokens,
          prompt_tokens_estimate: prompt.prompt_tokens_estimate,
        });
        span.setRationale(assemblyRationale(prompt, source));
        return prompt;
      },
    );

    const rawReply = await this.decisions.generate(collector, assembled);
    const resolved = resolveMentions(
      rawReply,
      input.question,
      members,
      input.inbound_mentioned_jids ?? [],
    );
    collector.setReply(resolved.text);
  }

  /**
   * Runs hybrid retrieval as one CONTEXT_RETRIEVAL span and buffers the log (chunk fates are
   * finalized later by prompt assembly). A thread not bound to a group is treated as an empty
   * retrieval so the low-confidence path still fires when messages were requested.
   */
  private async retrieve(
    collector: TraceCollector,
    input: PipelineInput,
    rewritten: string[],
    now: number,
  ): Promise<RetrievalPack> {
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

  /**
   * Tavily lookup as a WEB_SEARCH span. HTTP / timeout failures are recorded as ERROR and
   * recovered as an empty result set so the turn can still answer from group messages.
   */
  private async searchWeb(collector: TraceCollector, query: string): Promise<WebSearchOutcome> {
    try {
      return await collector.span('WEB_SEARCH', { query, provider: 'tavily' }, async (span) => {
        const outcome = await this.web.search(query);
        const preview = this.tracing.previewChars;
        span.setOutcome({
          provider: 'tavily',
          query: outcome.query,
          result_count: outcome.results.length,
          results: outcome.results.map((r) => ({
            title: r.title,
            url: r.url,
            content_preview: r.content.slice(0, preview),
            score: r.score,
          })),
          latency_ms: outcome.latency_ms,
        });
        span.setRationale(
          outcome.results.length
            ? `Tavily returned ${outcome.results.length} result(s).`
            : 'Tavily returned no results.',
        );
        return outcome;
      });
    } catch {
      return { query, results: [], latency_ms: 0 };
    }
  }

  private async fetchPages(collector: TraceCollector, hits: WebSearchHit[]): Promise<WebSearchHit[]> {
    const urls = this.web.selectExtractUrls(hits.map((h) => h.url));
    if (!urls.length) return hits;
    try {
      return await collector.span('WEB_FETCH', { urls, provider: 'tavily' }, async (span) => {
        const t0 = performance.now();
        const extracted = await this.web.extract(urls);
        const latency_ms = Math.round(performance.now() - t0);
        const pages = urls.map((url) => {
          const text = extracted.get(url) ?? '';
          return { url, chars: text.length, ok: text.length > 0 };
        });
        const succeeded = pages.filter((p) => p.ok).length;
        span.setOutcome({
          provider: 'tavily',
          requested: urls.length,
          succeeded,
          pages,
          latency_ms,
        });
        span.setRationale(`Tavily extracted ${succeeded} of ${urls.length} page(s).`);
        return hits.map((h) => {
          const text = extracted.get(h.url);
          return text ? { ...h, extracted: text } : h;
        });
      });
    } catch {
      return hits;
    }
  }
}

function assemblyRationale(
  prompt: { included_chunk_ids: string[]; budget_dropped_chunk_ids: string[]; web_result_count: number; template: { id: string; version: string }; context_budget_tokens: number },
  source: SearchSource,
): string {
  const parts = [`Assembled the ${prompt.template.id} v${prompt.template.version} prompt (search_source=${source})`];
  parts.push(`${prompt.included_chunk_ids.length} chat chunk(s)`);
  if (prompt.web_result_count) parts.push(`${prompt.web_result_count} web result(s)`);
  if (prompt.budget_dropped_chunk_ids.length) {
    parts.push(`dropped ${prompt.budget_dropped_chunk_ids.length} for the ${prompt.context_budget_tokens}-token budget`);
  }
  return `${parts[0]} with ${parts.slice(1).join('; ')}.`;
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

/**
 * In hybrid mode, enriches the web search query with the top retrieved group message so
 * chat-specific referents (e.g. "the restaurant Priya suggested" -> "Truffles Indiranagar")
 * are resolved before querying Tavily.
 */
function buildHybridWebQuery(baseQuery: string, retrievalPack: RetrievalPack | null): string {
  if (!retrievalPack) return baseQuery;
  const topKept = retrievalPack.log.retrieved_chunks.find((c) => c.drop_reason === null);
  if (!topKept) return baseQuery;
  const topText = (retrievalPack.texts.get(topKept.chunk_id) ?? topKept.content_preview ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!topText) return baseQuery;
  return `${baseQuery} (${topText.slice(0, 200)})`.slice(0, 380);
}
