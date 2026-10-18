/**
 * Strongly-typed models for the traceability layer.
 *
 * Property names are snake_case on purpose: they mirror the trace blueprint (and the JSON the
 * debug API returns) one-to-one, so a developer can read a payload next to the spec without
 * translating names. The rest of the codebase stays camelCase.
 */

// ------------------------------------------------------------------------------------------------
// Enumerations. `as const` arrays double as runtime lists (validation, SQL CHECK parity, tests).
// ------------------------------------------------------------------------------------------------

export const TURN_STATUSES = ['IN_PROGRESS', 'COMPLETED', 'FALLBACK_TRIGGERED', 'FAILED'] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

export const STEP_TYPES = [
  'QUERY_REWRITE',
  'INTENT_ROUTER',
  'GUARDRAIL_CHECK',
  'CONTEXT_RETRIEVAL',
  'WEB_SEARCH',
  'TOOL_EXECUTION',
  'PROMPT_ASSEMBLY',
  'LLM_GENERATION',
  'FALLBACK_HANDLER',
  /** Superset of the blueprint enum: the "low-confidence context" decision gets its own span. */
  'LOW_CONFIDENCE_CONTEXT',
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const SPAN_STATUSES = ['SUCCESS', 'RETRYING', 'FALLBACK', 'ERROR'] as const;
export type SpanStatus = (typeof SPAN_STATUSES)[number];

export const MESSAGE_ROLES = ['USER', 'ASSISTANT', 'SYSTEM'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const DROP_REASONS = ['BELOW_THRESHOLD', 'TOKEN_BUDGET_EXCEEDED', 'DUPLICATE', 'POLICY_FILTERED'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export const SEARCH_STRATEGIES = ['HYBRID', 'BM25', 'VECTOR_COSINE'] as const;
export type SearchStrategy = (typeof SEARCH_STRATEGIES)[number];

/** Arbitrary JSON-serializable payload. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// ------------------------------------------------------------------------------------------------
// A. ConversationTurn
// ------------------------------------------------------------------------------------------------

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ErrorDetails {
  error_code: string;
  message: string;
  stack_trace: string | null;
  /** The span that was open when the failure surfaced; null if it happened between spans. */
  failed_at_span_id: string | null;
}

export interface ConversationTurn {
  turn_id: string;
  session_id: string;
  idempotency_key: string;
  user_message_id: string;
  bot_message_id: string | null;
  user_input_raw: string;
  bot_reply_raw: string | null;
  status: TurnStatus;
  total_latency_ms: number;
  token_usage: TokenUsage;
  error_details: ErrorDetails | null;
  created_at: number;
  updated_at: number;
}

// ------------------------------------------------------------------------------------------------
// B. RetrievalLog
// ------------------------------------------------------------------------------------------------

export interface RetrievedChunk {
  /** Identifier of the stored message the chunk came from (group messages are the corpus). */
  chunk_id: string;
  doc_id: string;
  /** Raw relevance: cosine similarity when the chunk has an embedding, else lexical coverage. */
  similarity_score: number;
  /** Score after reranking (RRF fusion blended with recency / quote signals). */
  rerank_score: number | null;
  /** Sanitized snippet; never the unredacted text. */
  content_preview: string;
  metadata: JsonObject;
  used_in_final_prompt: boolean;
  drop_reason: DropReason | null;
  /** Component scores, kept so a developer can see why the ranking came out as it did. */
  scores: {
    cosine: number | null;
    bm25: number | null;
    lexical_coverage: number;
    rrf: number;
  };
}

export interface RetrievalLog {
  retrieval_id: string;
  turn_id: string;
  span_id: string;
  raw_query: string;
  rewritten_queries: string[];
  search_strategy: SearchStrategy;
  retrieved_chunks: RetrievedChunk[];
  latency_ms: number;
}

// ------------------------------------------------------------------------------------------------
// C. DecisionSpan
// ------------------------------------------------------------------------------------------------

export interface ModelConfig {
  model_name: string;
  temperature: number | null;
  prompt_template_id: string | null;
  prompt_version: string | null;
}

export interface DecisionSpan {
  span_id: string;
  turn_id: string;
  parent_span_id: string | null;
  sequence_order: number;
  step_type: StepType;
  input_state: JsonObject;
  decision_outcome: Json | null;
  rationale: string | null;
  model_config: ModelConfig | null;
  status: SpanStatus;
  started_at: number;
  ended_at: number;
  duration_ms: number;
}

// ------------------------------------------------------------------------------------------------
// D. Message
// ------------------------------------------------------------------------------------------------

export interface Message {
  message_id: string;
  session_id: string;
  turn_id: string;
  parent_message_id: string | null;
  role: MessageRole;
  content: string;
  /** Transport-level id (e.g. the WhatsApp message id) when the message travelled over one. */
  external_id: string | null;
  created_at: number;
}

// ------------------------------------------------------------------------------------------------
// Supporting: conversation thread (the blueprint's `session_id`)
// ------------------------------------------------------------------------------------------------

export interface ChatThread {
  session_id: string;
  owner_id: string;
  /** WhatsApp device session whose stored group messages this thread searches. */
  device_session_id: string | null;
  chat_jid: string | null;
  created_at: number;
}

export const emptyTokenUsage = (): TokenUsage => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
