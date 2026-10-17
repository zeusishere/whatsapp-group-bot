import { TraceCollector } from '../tracing/trace-collector.js';
import { LlmClient, LlmError, LlmRequest } from '../llm/llm-client.js';
import { ModelConfig, StepType } from '../models/types.js';
import { errorCode, errorMessage } from '../models/errors.js';

/** The model returned something that is not the JSON shape we asked for. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

/** Parses a model reply as JSON, tolerating a Markdown code fence around it. */
export function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new SchemaError(`Not valid JSON: ${(e as Error).message}`);
  }
}

export interface StructuredCall<T> {
  collector: TraceCollector;
  llm: LlmClient;
  step: StepType;
  system: string;
  prompt: string;
  jsonSchema?: Record<string, unknown>;
  temperature: number;
  maxOutputTokens: number;
  model_config: ModelConfig;
  /** Facts about the step's inputs, copied into every span's `input_state`. */
  input: Record<string, unknown>;
  /** Throws `SchemaError` when the parsed value does not have the expected shape. */
  validate: (raw: unknown) => T;
  /** Explains a successful decision for the span. */
  describe: (value: T) => { outcome: unknown; rationale: string };
  /** Deterministic substitute used when the model cannot produce a valid answer. */
  fallback: () => { value: T; outcome: unknown; rationale: string };
  /** Total model attempts (first try + repairs). Default 2: one bounded retry. */
  maxAttempts?: number;
}

export interface StructuredResult<T> {
  value: T;
  used_fallback: boolean;
  attempts: number;
}

type Attempt<T> = { ok: true; value: T } | { ok: false; retryable: boolean };

const MALFORMED_PREVIEW_CHARS = 1000;

/**
 * Calls the model for a JSON decision with a bounded retry and a deterministic fallback.
 *
 * Why every attempt is its own span: a trace should show *what happened*, including the bad
 * answer. A malformed reply produces a RETRYING span that stores the raw output (redacted and
 * cut by the collector). The next attempt is a sibling span whose prompt carries a repair hint.
 * If attempts run out, a FALLBACK span records the deterministic choice, so a malformed model
 * can never stall or fail a turn.
 */
export async function runStructured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
  const maxAttempts = Math.max(1, call.maxAttempts ?? 2);
  let repairHint = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await call.collector.span<Attempt<T>>(
      call.step,
      { ...call.input, attempt, max_attempts: maxAttempts, repair: attempt > 1 },
      async (span): Promise<Attempt<T>> => {
        span.setModelConfig(call.model_config);

        const request: LlmRequest = {
          system: call.system,
          prompt: call.prompt + repairHint,
          json: true,
          jsonSchema: call.jsonSchema,
          temperature: call.temperature,
          maxOutputTokens: call.maxOutputTokens,
        };

        let text: string;
        try {
          const response = await call.llm.generate(request);
          span.addTokens(response.usage); // tokens were spent even if the answer turns out unusable
          text = response.text;
        } catch (e) {
          const retryable = e instanceof LlmError ? e.retryable : false;
          span.setStatus('RETRYING');
          span.setOutcome({ error_code: errorCode(e), error: errorMessage(e), retryable });
          span.setRationale(`Model call failed (${errorCode(e)}); ${retryable && attempt < maxAttempts ? 'retrying' : 'falling back'}.`);
          return { ok: false, retryable };
        }

        try {
          const value = call.validate(parseJson(text));
          const described = call.describe(value);
          span.setOutcome(described.outcome);
          span.setRationale(described.rationale);
          return { ok: true, value };
        } catch (e) {
          const reason = errorMessage(e);
          span.setStatus('RETRYING');
          span.setOutcome({ malformed_output: text.slice(0, MALFORMED_PREVIEW_CHARS), validation_error: reason });
          span.setRationale(`Model output was malformed (${reason}); ${attempt < maxAttempts ? 'retrying with a repair hint' : 'falling back'}.`);
          repairHint =
            `\n\nYour previous reply was rejected: ${reason}. ` +
            'Reply again with ONLY a single valid JSON object that follows the required format.';
          return { ok: false, retryable: true };
        }
      },
    );

    if (result.ok) return { value: result.value, used_fallback: false, attempts: attempt };
    if (!result.retryable) {
      // e.g. bad credentials or a rejected request: another identical attempt cannot help.
      return fallbackSpan(call, attempt);
    }
  }
  return fallbackSpan(call, maxAttempts);
}

async function fallbackSpan<T>(call: StructuredCall<T>, attempts: number): Promise<StructuredResult<T>> {
  const value = await call.collector.span(call.step, { ...call.input, reason: 'model attempts exhausted', attempts }, (span) => {
    const fb = call.fallback();
    span.setStatus('FALLBACK');
    span.setOutcome(fb.outcome);
    span.setRationale(fb.rationale);
    return fb.value;
  });
  return { value, used_fallback: true, attempts };
}
