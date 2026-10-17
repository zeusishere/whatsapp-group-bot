import { Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { errorCode, errorMessage } from '../models/errors.js';
import { newId } from '../models/ids.js';
import {
  ConversationTurn,
  DecisionSpan,
  ErrorDetails,
  Json,
  ModelConfig,
  RetrievalLog,
  SpanStatus,
  StepType,
  TokenUsage,
  TurnStatus,
  emptyTokenUsage,
} from '../models/types.js';
import { Redactor } from './redactor.js';
import { TraceRepository } from './trace.repository.js';
import { traceContext } from './trace-context.js';

/** A hook that scrubs a JSON value before it is persisted. Must be pure and must not throw. */
export type Sanitizer = (value: Json) => Json;

export interface CollectorOptions {
  previewChars: number;
}

/** What a step uses to describe what it decided. Everything is optional; the status defaults to SUCCESS. */
export interface SpanHandle {
  readonly span_id: string;
  /** Adds to the sanitized snapshot of the step's inputs (e.g. facts only known mid-step). */
  setInput(patch: Record<string, unknown>): void;
  setOutcome(outcome: unknown): void;
  setRationale(text: string): void;
  setModelConfig(config: ModelConfig): void;
  setStatus(status: SpanStatus): void;
  /** Token usage reported by an LLM call made in this step; summed into the turn total. */
  addTokens(usage: Partial<TokenUsage>): void;
}

interface OpenSpan {
  span_id: string;
  parent_span_id: string | null;
  sequence_order: number;
  step_type: StepType;
  input: Record<string, unknown>;
  outcome: unknown;
  hasOutcome: boolean;
  rationale: string | null;
  model_config: ModelConfig | null;
  status: SpanStatus;
  started_at: number;
  t0: number;
}

/**
 * Records one turn's execution graph.
 *
 * One instance per turn (created by `TraceService.claim`). It owns four responsibilities:
 *
 *  1. Span lifecycle: ids, `parent_span_id` (through AsyncLocalStorage), a monotonic
 *     `sequence_order`, and wall-clock latency.
 *  2. Sanitization: every payload passes through the `Redactor` plus any registered hooks before
 *     it can reach storage.
 *  3. Durability: spans are written as soon as they close, so a process crash keeps everything
 *     that completed. Whatever is still buffered (retrieval logs, the bot message, the turn's
 *     final state) is written by `finalize()`, which `run()` calls from a `finally` block.
 *  4. Failure bookkeeping: remembers which span the failure surfaced in, so
 *     `error_details.failed_at_span_id` points at the right step.
 */
export class TraceCollector {
  private readonly logger = new Logger(TraceCollector.name);
  private readonly t0 = performance.now();
  private readonly sanitizers: Sanitizer[] = [];

  private sequence = 0;
  private readonly open = new Map<string, OpenSpan>();
  /** Closed spans whose database write has not (yet) succeeded. */
  private pendingSpans: DecisionSpan[] = [];
  private readonly retrievals: RetrievalLog[] = [];
  private readonly usage: TokenUsage = emptyTokenUsage();

  private reply: { message_id: string; content: string } | null = null;
  private fallback = false;
  private failure: { error: unknown } | null = null;
  /** Maps a thrown error to the innermost span it passed through. */
  private readonly errorSpan = new WeakMap<object, string>();
  private finalized: Promise<ConversationTurn> | null = null;

  constructor(
    readonly turn: ConversationTurn,
    private readonly repo: TraceRepository,
    private readonly redactor: Redactor,
    private readonly opts: CollectorOptions,
  ) {}

  get turn_id(): string {
    return this.turn.turn_id;
  }
  get session_id(): string {
    return this.turn.session_id;
  }
  get user_message_id(): string {
    return this.turn.user_message_id;
  }
  /** The id the bot's reply will be stored under (null until a reply is set). */
  get bot_message_id(): string | null {
    return this.reply?.message_id ?? null;
  }
  /** Id of the span currently executing in this async context, if any. */
  get current_span_id(): string | null {
    const frame = traceContext.getStore();
    return frame && frame.collector === this ? frame.spanId : null;
  }

  /** Registers an extra sanitization hook, applied after the built-in redactor. */
  addSanitizer(fn: Sanitizer): void {
    this.sanitizers.push(fn);
  }

  // ------------------------------------------------------------------- spans

  /**
   * Runs `fn` as a traced step. Spans started inside `fn` become its children.
   *
   * If `fn` throws, the span is closed with status ERROR and the error is rethrown unchanged:
   * whether a failed step aborts the turn or is recovered from (retry, fallback) is the
   * caller's decision, not the tracer's.
   */
  async span<T>(step_type: StepType, input: Record<string, unknown>, fn: (span: SpanHandle) => Promise<T> | T): Promise<T> {
    const span_id = newId();
    const open: OpenSpan = {
      span_id,
      parent_span_id: this.current_span_id,
      // Allocated at start, so a parent always sorts before its children and siblings sort by start.
      sequence_order: ++this.sequence,
      step_type,
      input: { ...input },
      outcome: null,
      hasOutcome: false,
      rationale: null,
      model_config: null,
      status: 'SUCCESS',
      started_at: Date.now(),
      t0: performance.now(),
    };
    this.open.set(span_id, open);

    const handle: SpanHandle = {
      span_id,
      setInput: (patch) => void Object.assign(open.input, patch),
      setOutcome: (outcome) => {
        open.outcome = outcome;
        open.hasOutcome = true;
      },
      setRationale: (text) => void (open.rationale = text),
      setModelConfig: (config) => void (open.model_config = config),
      setStatus: (status) => void (open.status = status),
      addTokens: (usage) => this.addTokens(usage),
    };

    try {
      const result = await traceContext.run({ collector: this, spanId: span_id }, () => fn(handle));
      this.close(open);
      return result;
    } catch (error) {
      // The first (innermost) span an error passes through is where it "failed".
      if (typeof error === 'object' && error !== null && !this.errorSpan.has(error)) {
        this.errorSpan.set(error, span_id);
      }
      open.status = 'ERROR';
      if (!open.hasOutcome) {
        open.outcome = { error_code: errorCode(error), error: errorMessage(error) };
        open.hasOutcome = true;
      }
      open.rationale ??= `Step failed: ${errorMessage(error)}`;
      this.close(open);
      throw error;
    }
  }

  private close(open: OpenSpan): void {
    if (!this.open.delete(open.span_id)) return; // already closed (e.g. by finalize)
    const ended_at = Date.now();
    const span: DecisionSpan = {
      span_id: open.span_id,
      turn_id: this.turn.turn_id,
      parent_span_id: open.parent_span_id,
      sequence_order: open.sequence_order,
      step_type: open.step_type,
      input_state: this.sanitizeObject(open.input),
      decision_outcome: open.hasOutcome ? this.sanitize(open.outcome) : null,
      rationale: open.rationale === null ? null : this.sanitizeText(open.rationale),
      model_config: open.model_config,
      status: open.status,
      started_at: open.started_at,
      ended_at,
      duration_ms: Math.max(0, Math.round(performance.now() - open.t0)),
    };
    this.pendingSpans.push(span);
    this.flushSpans();
  }

  /**
   * Writes closed spans. A failing write never propagates (tracing must not break the bot); the
   * spans stay buffered and `finalize()` tries once more, row by row, so one bad row cannot
   * take the rest down with it.
   */
  private flushSpans(rowByRow = false): void {
    if (!this.pendingSpans.length) return;
    try {
      this.repo.insertSpans(this.pendingSpans);
      this.pendingSpans = [];
    } catch (e) {
      if (!rowByRow) {
        this.logger.warn(`Could not persist ${this.pendingSpans.length} span(s), will retry: ${errorMessage(e)}`);
        return;
      }
      for (const s of this.pendingSpans) {
        try {
          this.repo.insertSpans([s]);
        } catch (err) {
          this.logger.error(`Dropping span ${s.span_id} (${s.step_type}): ${errorMessage(err)}`);
        }
      }
      this.pendingSpans = [];
    }
  }

  // --------------------------------------------------------------- retrieval

  /**
   * Buffers a retrieval log and returns it *by reference*. Whether a chunk reached the final
   * prompt (`used_in_final_prompt`, `drop_reason`) is only known after prompt assembly, so the
   * pipeline keeps mutating the log until then; it is written once, in `finalize()`.
   */
  recordRetrieval(span_id: string, data: Omit<RetrievalLog, 'retrieval_id' | 'turn_id' | 'span_id'>): RetrievalLog {
    const log: RetrievalLog = { retrieval_id: newId(), turn_id: this.turn.turn_id, span_id, ...data };
    this.retrievals.push(log);
    return log;
  }

  // ------------------------------------------------------------ turn outcome

  addTokens(usage: Partial<TokenUsage>): void {
    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    this.usage.prompt_tokens += prompt;
    this.usage.completion_tokens += completion;
    this.usage.total_tokens += usage.total_tokens ?? prompt + completion;
  }

  /** Stages the bot's reply. It is persisted (as an ASSISTANT message) by `finalize()`. */
  setReply(content: string): string {
    this.reply = { message_id: this.reply?.message_id ?? newId(), content };
    return this.reply.message_id;
  }

  /** Marks that the reply came from the deterministic fallback path instead of the model. */
  markFallback(): void {
    this.fallback = true;
  }

  /** Records that the turn failed. The error is *not* rethrown. */
  fail(error: unknown): void {
    this.failure ??= { error };
  }

  /**
   * Executes a turn with a guaranteed lifecycle:
   *  - an exception from `fn` marks the turn FAILED (it is not rethrown, the returned turn carries the outcome);
   *  - `finalize()` always runs, so spans, retrieval logs and the final turn state are persisted
   *    whether `fn` succeeded, threw, or timed out.
   */
  async run(fn: (collector: this) => Promise<void>): Promise<ConversationTurn> {
    let turn: ConversationTurn;
    try {
      await fn(this);
    } catch (error) {
      this.fail(error);
    } finally {
      // Runs on success, failure and timeout alike. finalize() never throws.
      turn = await this.finalize();
    }
    return turn;
  }

  /**
   * Persists everything still buffered and moves the turn to its terminal state. Idempotent and
   * never throws: if the database itself is failing there is nowhere left to report, so the
   * error is logged instead of masking the turn's original outcome.
   */
  finalize(): Promise<ConversationTurn> {
    this.finalized ??= this.doFinalize();
    return this.finalized;
  }

  private async doFinalize(): Promise<ConversationTurn> {
    // 1. Spans still open mean something escaped without closing them (aborted work). Close
    //    them as ERROR so the trace shows where execution stopped rather than silently omitting them.
    for (const open of [...this.open.values()].sort((a, b) => b.sequence_order - a.sequence_order)) {
      open.status = 'ERROR';
      open.rationale ??= 'Span was still open when the turn ended (aborted)';
      if (!this.failure) this.fail(new Error(`Span ${open.step_type} did not complete`));
      this.close(open);
    }
    this.flushSpans(true);

    // 2. Retrieval logs. Sanitized here, once, so no code path can persist an unmasked preview.
    try {
      this.repo.insertRetrievalLogs(this.retrievals.map((l) => this.sanitizeRetrieval(l)));
    } catch (e) {
      this.logger.error(`Could not persist retrieval logs for turn ${this.turn.turn_id}: ${errorMessage(e)}`);
    }

    // 3. Terminal state of the turn, plus the reply message, atomically.
    const failed = this.failure !== null;
    const status: TurnStatus = failed ? 'FAILED' : this.fallback ? 'FALLBACK_TRIGGERED' : 'COMPLETED';
    // A failed turn has no reply: `bot_message_id` is null when the failure came before generation.
    const reply = failed ? null : this.reply;
    const error_details = this.failure ? this.buildErrorDetails(this.failure.error) : null;
    const total_latency_ms = Math.round(performance.now() - this.t0);

    try {
      this.repo.finalizeTurn(
        {
          turn_id: this.turn.turn_id,
          status,
          bot_message_id: reply?.message_id ?? null,
          bot_reply_raw: reply?.content ?? null,
          total_latency_ms,
          token_usage: { ...this.usage },
          error_details,
        },
        reply ? { content: reply.content, external_id: null, parent_message_id: this.turn.user_message_id } : null,
      );
    } catch (e) {
      this.logger.error(`Could not finalize turn ${this.turn.turn_id}: ${errorMessage(e)}`);
    }
    return this.repo.getTurn(this.turn.turn_id) ?? { ...this.turn, status, total_latency_ms, token_usage: { ...this.usage }, error_details };
  }

  private buildErrorDetails(error: unknown): ErrorDetails {
    const failedAt = typeof error === 'object' && error !== null ? this.errorSpan.get(error) ?? null : null;
    return {
      error_code: errorCode(error),
      message: this.sanitizeText(errorMessage(error)),
      stack_trace: error instanceof Error && error.stack ? this.sanitizeText(error.stack) : null,
      failed_at_span_id: failedAt,
    };
  }

  // ------------------------------------------------------------ sanitization

  private sanitize(value: unknown): Json {
    let out = this.redactor.sanitize(value);
    for (const hook of this.sanitizers) {
      try {
        out = hook(out);
      } catch {
        // Fail closed: if a hook breaks we cannot vouch for the value, so do not store it.
        return '[sanitizer error]';
      }
    }
    return out;
  }

  private sanitizeObject(value: Record<string, unknown>): Record<string, Json> {
    const out = this.sanitize(value);
    return typeof out === 'object' && out !== null && !Array.isArray(out) ? out : {};
  }

  private sanitizeText(text: string): string {
    const out = this.sanitize(text);
    return typeof out === 'string' ? out : '[sanitizer error]';
  }

  private sanitizeRetrieval(log: RetrievalLog): RetrievalLog {
    return {
      ...log,
      raw_query: this.sanitizeText(log.raw_query),
      rewritten_queries: log.rewritten_queries.map((q) => this.sanitizeText(q)),
      retrieved_chunks: log.retrieved_chunks.map((c) => ({
        ...c,
        content_preview: this.sanitizeText(this.redactor.preview(c.content_preview, this.opts.previewChars)),
        metadata: this.sanitizeObject(c.metadata),
      })),
    };
  }
}
