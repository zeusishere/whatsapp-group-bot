import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { newId } from '../models/ids.js';
import {
  ChatThread,
  ConversationTurn,
  DecisionSpan,
  ErrorDetails,
  Message,
  ModelConfig,
  RetrievalLog,
  RetrievedChunk,
  TokenUsage,
  TurnStatus,
} from '../models/types.js';

// ------------------------------------------------------------------------------------------------
// Row shapes (as stored) and mappers. JSON columns are parsed defensively: a corrupt row must not
// make the whole debug endpoint unusable.
// ------------------------------------------------------------------------------------------------

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

type Row = Record<string, any>;

const toTurn = (r: Row): ConversationTurn => ({
  turn_id: r.turn_id,
  session_id: r.session_id,
  idempotency_key: r.idempotency_key,
  user_message_id: r.user_message_id,
  bot_message_id: r.bot_message_id,
  user_input_raw: r.user_input_raw,
  bot_reply_raw: r.bot_reply_raw,
  status: r.status,
  total_latency_ms: r.total_latency_ms,
  token_usage: parseJson<TokenUsage>(r.token_usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
  error_details: parseJson<ErrorDetails | null>(r.error_details, null),
  created_at: r.created_at,
  updated_at: r.updated_at,
});

const toSpan = (r: Row): DecisionSpan => ({
  span_id: r.span_id,
  turn_id: r.turn_id,
  parent_span_id: r.parent_span_id,
  sequence_order: r.sequence_order,
  step_type: r.step_type,
  input_state: parseJson(r.input_state, {}),
  decision_outcome: parseJson(r.decision_outcome, null),
  rationale: r.rationale,
  model_config: parseJson<ModelConfig | null>(r.model_config, null),
  status: r.status,
  started_at: r.started_at,
  ended_at: r.ended_at,
  duration_ms: r.duration_ms,
});

const toRetrieval = (r: Row): RetrievalLog => ({
  retrieval_id: r.retrieval_id,
  turn_id: r.turn_id,
  span_id: r.span_id,
  raw_query: r.raw_query,
  rewritten_queries: parseJson<string[]>(r.rewritten_queries, []),
  search_strategy: r.search_strategy,
  retrieved_chunks: parseJson<RetrievedChunk[]>(r.retrieved_chunks, []),
  latency_ms: r.latency_ms,
});

const toMessage = (r: Row): Message => ({
  message_id: r.message_id,
  session_id: r.session_id,
  turn_id: r.turn_id,
  parent_message_id: r.parent_message_id,
  role: r.role,
  content: r.content,
  external_id: r.external_id,
  created_at: r.created_at,
});

const toThread = (r: Row): ChatThread => ({
  session_id: r.session_id,
  owner_id: r.owner_id,
  device_session_id: r.device_session_id,
  chat_jid: r.chat_jid,
  created_at: r.created_at,
});

export interface ClaimInput {
  session_id: string;
  idempotency_key: string;
  user_input_raw: string;
  /** Transport id of the incoming message (WhatsApp message id), when there is one. */
  user_external_id: string | null;
}

export interface ClaimResult {
  /** True when this call created the turn; false when the idempotency key already existed. */
  created: boolean;
  turn: ConversationTurn;
}

export interface TurnFinalization {
  turn_id: string;
  status: TurnStatus;
  bot_message_id: string | null;
  bot_reply_raw: string | null;
  total_latency_ms: number;
  token_usage: TokenUsage;
  error_details: ErrorDetails | null;
}

/** All SQL for the trace entities. Synchronous (better-sqlite3), so each method is atomic on its own. */
@Injectable()
export class TraceRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.connection;
  }

  // ------------------------------------------------------------------- threads

  createThread(input: {
    owner_id: string;
    device_session_id: string | null;
    chat_jid: string | null;
  }): ChatThread {
    const thread: ChatThread = { session_id: newId(), created_at: Date.now(), ...input };
    this.db
      .prepare(
        `INSERT INTO chat_threads (session_id, owner_id, device_session_id, chat_jid, created_at)
         VALUES (@session_id, @owner_id, @device_session_id, @chat_jid, @created_at)`,
      )
      .run(thread);
    return thread;
  }

  getThread(sessionId: string): ChatThread | null {
    const r = this.db.prepare('SELECT * FROM chat_threads WHERE session_id = ?').get(sessionId) as Row | undefined;
    return r ? toThread(r) : null;
  }

  findThreadByBinding(deviceSessionId: string, chatJid: string): ChatThread | null {
    const r = this.db
      .prepare('SELECT * FROM chat_threads WHERE device_session_id = ? AND chat_jid = ?')
      .get(deviceSessionId, chatJid) as Row | undefined;
    return r ? toThread(r) : null;
  }

  /**
   * Returns the thread bound to (device, chat), creating it if needed. The UNIQUE constraint makes
   * concurrent creators converge on one row: the loser's insert fails and it re-reads.
   */
  getOrCreateBoundThread(ownerId: string, deviceSessionId: string, chatJid: string): ChatThread {
    const existing = this.findThreadByBinding(deviceSessionId, chatJid);
    if (existing) return existing;
    try {
      return this.createThread({ owner_id: ownerId, device_session_id: deviceSessionId, chat_jid: chatJid });
    } catch (e) {
      const raced = this.findThreadByBinding(deviceSessionId, chatJid);
      if (raced) return raced;
      throw e;
    }
  }

  // --------------------------------------------------------------------- turns

  /**
   * Atomically claims an idempotency key. On first use it inserts the turn (IN_PROGRESS) and the
   * user's message together; on a repeat it inserts nothing and returns the existing turn.
   * The unique index, not an in-memory check, is the guard, so it also holds across processes.
   */
  claimTurn(input: ClaimInput): ClaimResult {
    return this.db.transaction((): ClaimResult => {
      const now = Date.now();
      const turn_id = newId();
      const user_message_id = newId();

      const res = this.db
        .prepare(
          `INSERT INTO conversation_turns
             (turn_id, session_id, idempotency_key, user_message_id, user_input_raw, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'IN_PROGRESS', ?, ?)
           ON CONFLICT (idempotency_key) DO NOTHING`,
        )
        .run(turn_id, input.session_id, input.idempotency_key, user_message_id, input.user_input_raw, now, now);

      if (res.changes === 0) {
        const existing = this.db
          .prepare('SELECT * FROM conversation_turns WHERE idempotency_key = ?')
          .get(input.idempotency_key) as Row;
        return { created: false, turn: toTurn(existing) };
      }

      this.db
        .prepare(
          `INSERT INTO chat_messages (message_id, session_id, turn_id, parent_message_id, role, content, external_id, created_at)
           VALUES (?, ?, ?, NULL, 'USER', ?, ?, ?)`,
        )
        .run(user_message_id, input.session_id, turn_id, input.user_input_raw, input.user_external_id, now);

      return { created: true, turn: toTurn(this.db.prepare('SELECT * FROM conversation_turns WHERE turn_id = ?').get(turn_id) as Row) };
    })();
  }

  getTurn(turnId: string): ConversationTurn | null {
    const r = this.db.prepare('SELECT * FROM conversation_turns WHERE turn_id = ?').get(turnId) as Row | undefined;
    return r ? toTurn(r) : null;
  }

  /** The turn a message belongs to (either the user's or the bot's message). */
  getTurnByMessage(messageId: string): ConversationTurn | null {
    const r = this.db
      .prepare(
        `SELECT t.* FROM chat_messages m JOIN conversation_turns t ON t.turn_id = m.turn_id
         WHERE m.message_id = ?`,
      )
      .get(messageId) as Row | undefined;
    return r ? toTurn(r) : null;
  }

  /** Writes the terminal state of a turn, plus the bot's reply message, in one transaction. */
  finalizeTurn(f: TurnFinalization, reply: { content: string; external_id: string | null; parent_message_id: string } | null): void {
    this.db.transaction(() => {
      const now = Date.now();
      if (reply && f.bot_message_id) {
        const turn = this.getTurn(f.turn_id);
        if (turn) {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO chat_messages
                 (message_id, session_id, turn_id, parent_message_id, role, content, external_id, created_at)
               VALUES (?, ?, ?, ?, 'ASSISTANT', ?, ?, ?)`,
            )
            .run(f.bot_message_id, turn.session_id, f.turn_id, reply.parent_message_id, reply.content, reply.external_id, now);
        }
      }
      this.db
        .prepare(
          `UPDATE conversation_turns
           SET status = @status, bot_message_id = @bot_message_id, bot_reply_raw = @bot_reply_raw,
               total_latency_ms = @total_latency_ms, token_usage = @token_usage,
               error_details = @error_details, updated_at = @updated_at
           WHERE turn_id = @turn_id`,
        )
        .run({
          ...f,
          token_usage: JSON.stringify(f.token_usage),
          error_details: f.error_details ? JSON.stringify(f.error_details) : null,
          updated_at: now,
        });
    })();
  }

  /** Records the transport id (e.g. WhatsApp id) of an already-persisted assistant message. */
  setMessageExternalId(messageId: string, externalId: string): void {
    this.db.prepare('UPDATE chat_messages SET external_id = ? WHERE message_id = ?').run(externalId, messageId);
  }

  /**
   * Called once at boot. Anything still IN_PROGRESS belongs to a process that no longer exists,
   * so it can only be reported as failed; leaving it open would also block its idempotency key.
   */
  reapStaleTurns(): number {
    const details: ErrorDetails = {
      error_code: 'PROCESS_RESTART',
      message: 'The process stopped while this turn was in progress',
      stack_trace: null,
      failed_at_span_id: null,
    };
    return this.db
      .prepare(
        `UPDATE conversation_turns SET status = 'FAILED', error_details = ?, updated_at = ?
         WHERE status = 'IN_PROGRESS'`,
      )
      .run(JSON.stringify(details), Date.now()).changes;
  }

  // --------------------------------------------------------------------- spans

  insertSpans(spans: DecisionSpan[]): void {
    if (!spans.length) return;
    const stmt = this.db.prepare(
      `INSERT INTO decision_spans
         (span_id, turn_id, parent_span_id, sequence_order, step_type, input_state, decision_outcome,
          rationale, model_config, status, started_at, ended_at, duration_ms)
       VALUES (@span_id, @turn_id, @parent_span_id, @sequence_order, @step_type, @input_state, @decision_outcome,
               @rationale, @model_config, @status, @started_at, @ended_at, @duration_ms)`,
    );
    this.db.transaction(() => {
      for (const s of spans) {
        stmt.run({
          ...s,
          input_state: JSON.stringify(s.input_state),
          decision_outcome: s.decision_outcome === null ? null : JSON.stringify(s.decision_outcome),
          model_config: s.model_config ? JSON.stringify(s.model_config) : null,
        });
      }
    })();
  }

  getSpans(turnId: string): DecisionSpan[] {
    return (this.db.prepare('SELECT * FROM decision_spans WHERE turn_id = ? ORDER BY sequence_order').all(turnId) as Row[]).map(toSpan);
  }

  // ----------------------------------------------------------------- retrieval

  insertRetrievalLogs(logs: RetrievalLog[]): void {
    if (!logs.length) return;
    const stmt = this.db.prepare(
      `INSERT INTO retrieval_logs
         (retrieval_id, turn_id, span_id, raw_query, rewritten_queries, search_strategy, retrieved_chunks, latency_ms)
       VALUES (@retrieval_id, @turn_id, @span_id, @raw_query, @rewritten_queries, @search_strategy, @retrieved_chunks, @latency_ms)`,
    );
    this.db.transaction(() => {
      for (const l of logs) {
        stmt.run({
          ...l,
          rewritten_queries: JSON.stringify(l.rewritten_queries),
          retrieved_chunks: JSON.stringify(l.retrieved_chunks),
        });
      }
    })();
  }

  getRetrievalLogs(turnId: string): RetrievalLog[] {
    return (this.db.prepare('SELECT * FROM retrieval_logs WHERE turn_id = ? ORDER BY retrieval_id').all(turnId) as Row[]).map(toRetrieval);
  }

  // ------------------------------------------------------------------ messages

  getMessagesForTurn(turnId: string): Message[] {
    return (this.db.prepare('SELECT * FROM chat_messages WHERE turn_id = ? ORDER BY created_at, message_id').all(turnId) as Row[]).map(toMessage);
  }

  getMessage(messageId: string): Message | null {
    const r = this.db.prepare('SELECT * FROM chat_messages WHERE message_id = ?').get(messageId) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  /**
   * Chat history for a thread, oldest first, excluding the turn being processed (its user message
   * is already stored and is passed to the pipeline separately).
   */
  recentMessages(sessionId: string, excludeTurnId: string, limit: number): Message[] {
    if (limit <= 0) return [];
    const rows = this.db
      .prepare(
        `SELECT m.* FROM chat_messages m
         JOIN conversation_turns t ON t.turn_id = m.turn_id
         WHERE m.session_id = ? AND m.turn_id <> ? AND t.status IN ('COMPLETED', 'FALLBACK_TRIGGERED')
         ORDER BY m.created_at DESC, m.message_id DESC LIMIT ?`,
      )
      .all(sessionId, excludeTurnId, limit * 2) as Row[];
    return rows.map(toMessage).reverse();
  }
}
