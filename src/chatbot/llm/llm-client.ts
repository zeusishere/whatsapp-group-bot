import { CodedError } from '../models/errors.js';
import { TokenUsage } from '../models/types.js';

export interface LlmRequest {
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Ask for a JSON document (provider JSON mode). The caller still validates the result. */
  json?: boolean;
  /** JSON Schema for the response, when `json` is set. */
  jsonSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface LlmResponse {
  text: string;
  usage: TokenUsage;
  model: string;
  finish_reason: string | null;
}

/** A failure of a model call, flagged with whether trying again could help. */
export class LlmError extends CodedError {
  constructor(
    code: 'LLM_TIMEOUT' | 'LLM_RATE_LIMITED' | 'LLM_UNAVAILABLE' | 'LLM_REJECTED' | 'LLM_EMPTY_RESPONSE' | 'LLM_NOT_CONFIGURED',
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
    this.name = 'LlmError';
  }
}

/**
 * Text generation. An abstract class (not an interface) so it doubles as the Nest injection
 * token; tests substitute a deterministic stub.
 */
export abstract class LlmClient {
  abstract readonly model_name: string;
  /** False when no credentials are configured; callers must not start turns in that case. */
  abstract readonly configured: boolean;
  /** One attempt, no internal retry: retries are visible steps in the trace, so the pipeline owns them. */
  abstract generate(request: LlmRequest): Promise<LlmResponse>;
}

export type EmbeddingKind = 'query' | 'document';

export abstract class EmbeddingClient {
  abstract readonly model_name: string;
  abstract readonly configured: boolean;
  /** Returns one vector per input text, in order. */
  abstract embed(texts: string[], kind: EmbeddingKind): Promise<number[][]>;
}
