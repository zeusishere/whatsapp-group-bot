import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/env.schema.js';
import { CodedError, errorCode } from '../models/errors.js';
import { Json, Message } from '../models/types.js';
import { LlmClient, LlmError } from '../llm/llm-client.js';
import { TraceCollector } from '../tracing/trace-collector.js';
import { AssembledPrompt, appendWebCitations } from './prompt-assembler.service.js';
import {
  INTENT_ROUTER_SCHEMA,
  PROMPTS,
  QUERY_REWRITE_SCHEMA,
  QUERY_REWRITE_SYSTEM,
  ROUTES,
  Route,
  SEARCH_SOURCES,
  SearchSource,
  intentRouterSystem,
  modelConfig,
} from './prompts.js';
import { SchemaError, runStructured } from './structured-output.js';
import { keywords } from './text-utils.js';
import { ToolContext, ToolRegistry } from './tool.registry.js';

/** Why the deterministic fallback reply was used. */
export type FallbackCode =
  | 'EMPTY_INPUT'
  | 'INPUT_TOO_LONG'
  | 'PROMPT_INJECTION'
  | 'OUT_OF_SCOPE'
  | 'LOW_CONFIDENCE_CONTEXT';

export interface GuardrailVerdict {
  allowed: boolean;
  code: FallbackCode | null;
}

export interface RouteDecision {
  route: Route;
  search_source: SearchSource;
  confidence: number;
  rationale: string;
  tool: string | null;
  args: Record<string, Json>;
}

export interface TurnContext {
  question: string;
  history: Pick<Message, 'role' | 'content'>[];
  quoted_message_id: string | null;
  now: number;
}

/** Below this the router's choice is distrusted and the safe default (answer from context) is used. */
const MIN_ROUTE_CONFIDENCE = 0.3;
const TOOL_TIMEOUT_MS = 5000;
const MAX_REWRITES = 3;

const INJECTION_PATTERNS = [
  /\bignore\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)\b/i,
  /\b(?:reveal|show|print|repeat)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:system\s+prompt|hidden\s+instructions?|initial\s+instructions?)\b/i,
  /\bdisregard\s+(?:all\s+|your\s+)?(?:previous\s+|prior\s+)?(?:instructions?|rules?)\b/i,
];

const FALLBACK_REPLIES: Record<Exclude<FallbackCode, 'LOW_CONFIDENCE_CONTEXT'>, string> = {
  EMPTY_INPUT: 'Please send a message with some text and I will try to help.',
  INPUT_TOO_LONG: 'That message is too long for me to process. Could you shorten it?',
  PROMPT_INJECTION: "I can't help with that request.",
  OUT_OF_SCOPE: "I can't help with that request.",
};

/**
 * The judgement calls of a turn: guardrails, query rewriting, routing, tool use, fallback and
 * generation. Each runs as a traced span that records the decision AND the reasoning, so the
 * audit trail answers "why did the bot do that?" and not just "what did it do?".
 *
 * Any step that depends on the model has a deterministic substitute. A confused or unavailable
 * model degrades to simple rules instead of derailing the turn; only the final generation is
 * allowed to fail the turn, because there is no honest substitute for the answer itself.
 */
@Injectable()
export class DecisionEngine {
  private readonly bot: AppConfig['bot'];
  private readonly llmCfg: AppConfig['llm'];
  private readonly webSearchEnabled: boolean;

  constructor(
    private readonly llm: LlmClient,
    private readonly tools: ToolRegistry,
    config: ConfigService<AppConfig, true>,
  ) {
    this.bot = config.get('bot', { infer: true });
    this.llmCfg = config.get('llm', { infer: true });
    this.webSearchEnabled = config.get('webSearch', { infer: true }).apiKey.length > 0;
  }

  // ---------------------------------------------------------------- guardrail

  async guardrail(collector: TraceCollector, question: string): Promise<GuardrailVerdict> {
    return collector.span('GUARDRAIL_CHECK', { input_chars: question.length, max_input_chars: this.bot.maxInputChars }, (span) => {
      let code: FallbackCode | null = null;
      let rationale = 'Input is non-empty, within the size limit and matches no known injection pattern.';

      if (!question.trim()) {
        code = 'EMPTY_INPUT';
        rationale = 'The message has no text.';
      } else if (question.length > this.bot.maxInputChars) {
        code = 'INPUT_TOO_LONG';
        rationale = `The message is ${question.length} characters; the limit is ${this.bot.maxInputChars}.`;
      } else if (INJECTION_PATTERNS.some((p) => p.test(question))) {
        code = 'PROMPT_INJECTION';
        rationale = 'The message tries to override or extract the bot instructions.';
      }

      if (code) span.setStatus('FALLBACK');
      span.setOutcome({ allowed: code === null, code });
      span.setRationale(rationale);
      return { allowed: code === null, code };
    });
  }

  // ------------------------------------------------------------ query rewrite

  async rewriteQuery(collector: TraceCollector, ctx: TurnContext): Promise<string[]> {
    const template = PROMPTS.queryRewrite;
    const history = formatHistory(ctx.history);
    const result = await runStructured<string[]>({
      collector,
      llm: this.llm,
      step: 'QUERY_REWRITE',
      system: QUERY_REWRITE_SYSTEM,
      prompt: `${history ? `<history>\n${history}\n</history>\n\n` : ''}Message to rewrite:\n${ctx.question}`,
      jsonSchema: QUERY_REWRITE_SCHEMA,
      temperature: 0,
      maxOutputTokens: 200,
      model_config: modelConfig(this.llm.model_name, 0, template),
      input: { question: ctx.question, history_messages: ctx.history.length },
      validate: (raw) => {
        const queries = (raw as { queries?: unknown } | null)?.queries;
        if (!Array.isArray(queries)) throw new SchemaError('"queries" must be an array of strings');
        const clean = queries
          .filter((q): q is string => typeof q === 'string')
          .map((q) => q.trim().slice(0, 200))
          .filter(Boolean)
          .slice(0, MAX_REWRITES);
        if (!clean.length) throw new SchemaError('"queries" must contain at least one non-empty string');
        return clean;
      },
      describe: (queries) => ({
        outcome: { rewritten_queries: queries },
        rationale: `Reformulated the message into ${queries.length} search ${queries.length === 1 ? 'query' : 'queries'}, resolving references from the conversation history.`,
      }),
      fallback: () => {
        const queries = heuristicQueries(ctx.question);
        return {
          value: queries,
          outcome: { rewritten_queries: queries, method: 'keyword_extraction' },
          rationale: 'The model could not produce valid queries; used the message keywords as the search query instead.',
        };
      },
    });
    return result.value;
  }

  // ------------------------------------------------------------------- router

  async route(collector: TraceCollector, ctx: TurnContext): Promise<RouteDecision> {
    const template = PROMPTS.intentRouter;
    const history = formatHistory(ctx.history);
    const result = await runStructured<RouteDecision>({
      collector,
      llm: this.llm,
      step: 'INTENT_ROUTER',
      system: intentRouterSystem(this.tools.list()),
      prompt:
        `${history ? `<history>\n${history}\n</history>\n\n` : ''}` +
        `${ctx.quoted_message_id ? `The user is replying to message id "${ctx.quoted_message_id}".\n\n` : ''}` +
        `Message to route:\n${ctx.question}`,
      jsonSchema: INTENT_ROUTER_SCHEMA,
      temperature: 0,
      maxOutputTokens: 300,
      model_config: modelConfig(this.llm.model_name, 0, template),
      input: { question: ctx.question, quoted_message_id: ctx.quoted_message_id, tools: this.tools.list().map((t) => t.name) },
      validate: (raw) => this.validateRoute(raw),
      describe: (d) => ({
        outcome: {
          selected_route: d.route,
          search_source: d.search_source,
          confidence: d.confidence,
          ...(d.tool ? { tool_called: d.tool, args: d.args } : {}),
        },
        rationale: d.rationale,
      }),
      fallback: () => {
        const d = heuristicRoute(ctx.question, ctx.quoted_message_id);
        return {
          value: d,
          outcome: {
            selected_route: d.route,
            search_source: d.search_source,
            confidence: d.confidence,
            method: 'rules',
            ...(d.tool ? { tool_called: d.tool, args: d.args } : {}),
          },
          rationale: d.rationale,
        };
      },
    });
    return result.value;
  }

  private validateRoute(raw: unknown): RouteDecision {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SchemaError('expected a JSON object');
    const o = raw as Record<string, unknown>;
    if (typeof o.route !== 'string' || !(ROUTES as readonly string[]).includes(o.route)) {
      throw new SchemaError(`"route" must be one of: ${ROUTES.join(', ')}`);
    }
    if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence)) throw new SchemaError('"confidence" must be a number');
    if (typeof o.rationale !== 'string' || !o.rationale.trim()) throw new SchemaError('"rationale" must be a non-empty string');
    if (o.search_source !== undefined && (typeof o.search_source !== 'string' || !(SEARCH_SOURCES as readonly string[]).includes(o.search_source))) {
      throw new SchemaError(`"search_source" must be one of: ${SEARCH_SOURCES.join(', ')}`);
    }

    let route = o.route as Route;
    const confidence = Math.min(1, Math.max(0, o.confidence));
    let rationale = o.rationale.trim().slice(0, 1000);
    let tool: string | null = null;
    let args: Record<string, Json> = {};
    let search_source = coerceSearchSource(route, o.search_source);

    if (route === 'use_tool') {
      const def = typeof o.tool === 'string' ? this.tools.get(o.tool) : undefined;
      if (!def) throw new SchemaError(`"tool" must be one of: ${this.tools.list().map((t) => t.name).join(', ')}`);
      try {
        args = def.validate(o.args ?? {});
      } catch (e) {
        throw new SchemaError(`invalid args for ${def.name}: ${(e as Error).message}`);
      }
      tool = def.name;
    }

    if (confidence < MIN_ROUTE_CONFIDENCE && route !== 'answer_from_context') {
      rationale += ` (Overridden: confidence ${confidence.toFixed(2)} is below ${MIN_ROUTE_CONFIDENCE}; defaulting to answering from context.)`;
      route = 'answer_from_context';
      tool = null;
      args = {};
      if (search_source === 'none') search_source = 'messages';
    }

    if ((search_source === 'web' || search_source === 'hybrid') && !this.webSearchEnabled) {
      rationale += ' (Overridden: web search is not configured; searching group messages instead.)';
      search_source = 'messages';
    }

    return { route, search_source, confidence, rationale, tool, args };
  }

  // --------------------------------------------------------------------- tools

  /**
   * Runs a tool inside a TOOL_EXECUTION span. A failing or slow tool does not fail the turn
   * (the answer can still be built from retrieved context); the span records the error and
   * `null` is returned.
   */
  async executeTool(collector: TraceCollector, name: string, args: Record<string, Json>, ctx: ToolContext): Promise<Json | null> {
    const tool = this.tools.get(name);
    try {
      return await collector.span('TOOL_EXECUTION', { tool: name, args }, async (span) => {
        if (!tool) throw new CodedError('TOOL_UNKNOWN', `Unknown tool: ${name}`);
        const result = await withTimeout(Promise.resolve(tool.run(args, ctx)), TOOL_TIMEOUT_MS, `Tool ${name} timed out`);
        span.setOutcome({ tool_called: name, result });
        span.setRationale(`Selected by the router; ${tool.description}`);
        return result;
      });
    } catch {
      return null; // already recorded as an ERROR span by the collector
    }
  }

  // ------------------------------------------------------------------ fallback

  /** Low-confidence context: records the decision, then lets the caller trigger the fallback reply. */
  async lowConfidenceContext(
    collector: TraceCollector,
    detail: {
      candidates: number;
      best_similarity: number | null;
      min_similarity: number;
      drop_reasons: Record<string, number>;
      search_source: SearchSource;
      web_results: number;
    },
  ): Promise<void> {
    await collector.span('LOW_CONFIDENCE_CONTEXT', { ...detail }, (span) => {
      span.setStatus('FALLBACK');
      span.setOutcome({ code: 'LOW_CONFIDENCE_CONTEXT', action: 'deterministic_fallback', ...detail });
      span.setRationale(lowConfidenceRationale(detail));
    });
  }

  /** Produces the reply without calling the model, and flags the turn as FALLBACK_TRIGGERED. */
  async fallback(collector: TraceCollector, code: FallbackCode): Promise<string> {
    return collector.span('FALLBACK_HANDLER', { code }, (span) => {
      const reply = code === 'LOW_CONFIDENCE_CONTEXT' ? this.bot.fallbackReply : FALLBACK_REPLIES[code];
      collector.setReply(reply);
      collector.markFallback();
      span.setStatus('FALLBACK');
      span.setOutcome({ code, reply_source: 'deterministic' });
      span.setRationale(`Replied with a fixed message (${code}) rather than a model-generated one.`);
      return reply;
    });
  }

  // ---------------------------------------------------------------- generation

  /**
   * Generates the reply. Transient failures (timeout, rate limit, 5xx) are retried up to
   * `llm.maxRetries` times, each attempt a separate span so retries are visible. A final failure
   * is thrown: the turn is then recorded as FAILED with everything completed so far preserved.
   */
  async generate(collector: TraceCollector, prompt: AssembledPrompt): Promise<string> {
    const maxAttempts = this.llmCfg.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const text = await collector.span(
        'LLM_GENERATION',
        {
          attempt,
          max_attempts: maxAttempts,
          included_chunks: prompt.included_chunk_ids.length,
          prompt_tokens_estimate: prompt.prompt_tokens_estimate,
        },
        async (span) => {
          span.setModelConfig(modelConfig(this.llm.model_name, this.llmCfg.temperature, prompt.template));
          try {
            const response = await this.llm.generate({
              system: prompt.system,
              prompt: prompt.prompt,
              temperature: this.llmCfg.temperature,
              maxOutputTokens: this.bot.maxOutputTokens,
            });
            span.addTokens(response.usage);
            const rawReply = response.text.trim();
            const reply = appendWebCitations(rawReply, prompt.web_results ?? []);
            span.setOutcome({
              finish_reason: response.finish_reason,
              output_chars: reply.length,
              citations_appended: reply !== rawReply,
              usage: { ...response.usage },
            });
            span.setRationale(
              prompt.included_chunk_ids.length || prompt.web_result_count
                ? `Answered from ${prompt.included_chunk_ids.length} retrieved chunk(s) and ${prompt.web_result_count} web result(s) within a ${prompt.context_budget_tokens}-token context budget.`
                : 'Generated without retrieved context.',
            );
            return reply;
          } catch (e) {
            if (e instanceof LlmError && e.retryable && attempt < maxAttempts) {
              span.setStatus('RETRYING');
              span.setOutcome({ error_code: errorCode(e), error: e.message });
              span.setRationale(`Transient model failure (${e.code}); retrying (attempt ${attempt + 1} of ${maxAttempts}).`);
              return null;
            }
            throw e; // recorded as ERROR by the collector; fails the turn
          }
        },
      );
      if (text !== null) return text;
      await sleep(300 * attempt);
    }
    throw new CodedError('LLM_GENERATION_FAILED', 'Generation did not complete');
  }
}

// -------------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CodedError('TOOL_TIMEOUT', message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function formatHistory(history: Pick<Message, 'role' | 'content'>[]): string {
  return history.map((h) => `${h.role === 'USER' ? 'USER' : 'ASSISTANT'}: ${h.content.slice(0, 400)}`).join('\n');
}

/** Deterministic query used when the rewrite model is unavailable or malformed. */
export function heuristicQueries(question: string): string[] {
  const terms = keywords(question);
  return [terms.length ? terms.join(' ') : question.trim()].filter(Boolean);
}

/** Rule-based routing used when the router model is unavailable or malformed. */
export function heuristicRoute(question: string, quotedMessageId: string | null): RouteDecision {
  const text = question.trim();
  if (/\b(?:what(?:'s| is) the (?:time|date)|current (?:time|date)|today'?s date|what day is it)\b/i.test(text)) {
    return {
      route: 'use_tool',
      search_source: 'none',
      confidence: 0.6,
      rationale: 'Rule: the message asks for the current date or time.',
      tool: 'current_datetime',
      args: {},
    };
  }
  if (quotedMessageId && text.length <= 140) {
    return {
      route: 'use_tool',
      search_source: 'messages',
      confidence: 0.5,
      rationale: 'Rule: a short reply to an earlier message; fetching that message for context.',
      tool: 'lookup_quoted_message',
      args: { message_id: quotedMessageId },
    };
  }
  if (/^(?:hi|hello|hey|thanks|thank you|thx|good (?:morning|afternoon|evening|night))\b[\s!.?,]*$/i.test(text)) {
    return {
      route: 'smalltalk',
      search_source: 'none',
      confidence: 0.6,
      rationale: 'Rule: the message is a greeting or thanks.',
      tool: null,
      args: {},
    };
  }
  return {
    route: 'answer_from_context',
    search_source: 'messages',
    confidence: 0.4,
    rationale: 'Rule: default route; search the chat history for an answer.',
    tool: null,
    args: {},
  };
}

function coerceSearchSource(route: Route, raw: unknown): SearchSource {
  if (route === 'smalltalk' || route === 'clarify' || route === 'out_of_scope') return 'none';
  const source = typeof raw === 'string' && (SEARCH_SOURCES as readonly string[]).includes(raw) ? (raw as SearchSource) : 'messages';
  if (route === 'answer_from_context' && source === 'none') return 'messages';
  return source;
}

function lowConfidenceRationale(detail: {
  candidates: number;
  search_source: SearchSource;
  web_results: number;
}): string {
  if (detail.search_source === 'web') {
    return 'Web search returned no usable results, so answering would require guessing. Using the deterministic fallback instead of generating.';
  }
  if (detail.search_source === 'hybrid') {
    return 'Neither group messages nor web search produced usable results. Using the deterministic fallback instead of generating.';
  }
  return detail.candidates === 0
    ? 'Retrieval returned no candidates, so answering would require guessing. Using the deterministic fallback instead of generating.'
    : `None of ${detail.candidates} candidate(s) cleared the relevance threshold. Using the deterministic fallback instead of generating from weak context.`;
}
