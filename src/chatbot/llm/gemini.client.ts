import { ApiError, GoogleGenAI } from '@google/genai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/env.schema.js';
import { EmbeddingClient, EmbeddingKind, LlmClient, LlmError, LlmRequest, LlmResponse } from './llm-client.js';

/** Output size of stored embeddings. gemini-embedding-001 supports truncation; smaller = less storage. */
export const EMBEDDING_DIMENSIONS = 768;

/** Shared SDK handle: one HTTP client for both generation and embeddings. */
@Injectable()
export class GeminiSdk {
  readonly client: GoogleGenAI | null;
  readonly configured: boolean;

  constructor(config: ConfigService<AppConfig, true>) {
    const { apiKey } = config.get('llm', { infer: true });
    this.configured = apiKey.length > 0;
    this.client = this.configured ? new GoogleGenAI({ apiKey }) : null;
  }

  require(): GoogleGenAI {
    if (!this.client) throw new LlmError('LLM_NOT_CONFIGURED', 'llm.apiKey is not set', false);
    return this.client;
  }
}

/** Maps SDK/transport failures onto `LlmError`, deciding what is worth retrying. */
export function toLlmError(e: unknown, timedOut: boolean): LlmError {
  if (e instanceof LlmError) return e;
  if (timedOut) return new LlmError('LLM_TIMEOUT', 'The model call timed out', true, { cause: e });
  if (e instanceof ApiError) {
    if (e.status === 429) return new LlmError('LLM_RATE_LIMITED', `Rate limited by the model API: ${e.message}`, true, { cause: e });
    if (e.status >= 500) return new LlmError('LLM_UNAVAILABLE', `Model API error ${e.status}: ${e.message}`, true, { cause: e });
    return new LlmError('LLM_REJECTED', `Model API rejected the request (${e.status}): ${e.message}`, false, { cause: e });
  }
  // Network-level failures (DNS, reset, ...) are transient.
  return new LlmError('LLM_UNAVAILABLE', `Model call failed: ${(e as Error)?.message ?? String(e)}`, true, { cause: e });
}

/** Runs `fn` with an AbortSignal that fires after `timeoutMs`. Reports whether the timeout was what stopped it. */
async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (e) {
    throw toLlmError(e, timedOut);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class GeminiLlmClient extends LlmClient {
  readonly model_name: string;
  private readonly cfg: AppConfig['llm'];

  constructor(
    private readonly sdk: GeminiSdk,
    config: ConfigService<AppConfig, true>,
  ) {
    super();
    this.cfg = config.get('llm', { infer: true });
    this.model_name = this.cfg.model;
  }

  get configured(): boolean {
    return this.sdk.configured;
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const ai = this.sdk.require();
    const timeoutMs = request.timeoutMs ?? this.cfg.requestTimeoutMs;

    const response = await withTimeout(timeoutMs, (abortSignal) =>
      ai.models.generateContent({
        model: this.model_name,
        contents: request.prompt,
        config: {
          systemInstruction: request.system,
          temperature: request.temperature ?? this.cfg.temperature,
          maxOutputTokens: request.maxOutputTokens,
          abortSignal,
          ...(request.json
            ? { responseMimeType: 'application/json', ...(request.jsonSchema ? { responseJsonSchema: request.jsonSchema } : {}) }
            : {}),
          // (*)-flash model "thinks" by default and bills those tokens against maxOutputTokens, which can
          // truncate short structured answers. Routing/rewrite/answers here need no deliberation.
          ...(/flash/i.test(this.model_name) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),

        },
      }),
    );

    const text = response.text ?? '';
    if (!text.trim()) {
      const reason = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? 'unknown';
      throw new LlmError('LLM_EMPTY_RESPONSE', `The model returned no text (reason: ${reason})`, false);
    }
    const u = response.usageMetadata;
    const prompt_tokens = u?.promptTokenCount ?? 0;
    const completion_tokens = (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0);
    return {
      text,
      usage: { prompt_tokens, completion_tokens, total_tokens: u?.totalTokenCount ?? prompt_tokens + completion_tokens },
      model: this.model_name,
      finish_reason: response.candidates?.[0]?.finishReason ?? null,
    };
  }
}

@Injectable()
export class GeminiEmbeddingClient extends EmbeddingClient {
  readonly model_name: string;
  private readonly cfg: AppConfig['llm'];

  constructor(
    private readonly sdk: GeminiSdk,
    config: ConfigService<AppConfig, true>,
  ) {
    super();
    this.cfg = config.get('llm', { infer: true });
    this.model_name = this.cfg.embeddingModel;
  }

  get configured(): boolean {
    return this.sdk.configured;
  }

  async embed(texts: string[], kind: EmbeddingKind): Promise<number[][]> {
    if (!texts.length) return [];
    const ai = this.sdk.require();
    const response = await withTimeout(this.cfg.requestTimeoutMs, (abortSignal) =>
      ai.models.embedContent({
        model: this.model_name,
        contents: texts,
        config: {
          // Asymmetric task types: queries and documents are embedded differently for better recall.
          taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
          outputDimensionality: EMBEDDING_DIMENSIONS,
          abortSignal,
        },
      }),
    );
    const vectors = (response.embeddings ?? []).map((e) => e.values ?? []);
    if (vectors.length !== texts.length || vectors.some((v) => v.length === 0)) {
      throw new LlmError('LLM_EMPTY_RESPONSE', `Embedding API returned ${vectors.length} vectors for ${texts.length} texts`, false);
    }
    return vectors;
  }
}
