import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { MessagesRepository } from '../../messages/messages.repository.js';
import { EmbeddingClient } from '../llm/llm-client.js';
import { fromBlob, normalize, toBlob } from './vector-math.js';

interface QueueItem {
  sessionId: string;
  groupId: string;
  messageId: string;
  text: string;
}

const BATCH_SIZE = 32;
const FLUSH_DELAY_MS = 1000;
/** Upper bound on buffered messages; beyond it new ones are skipped and found later by backfill. */
const MAX_QUEUE = 2000;
/** Messages shorter than this carry no semantic signal worth an API call. */
const MIN_TEXT_LENGTH = 3;

/**
 * Keeps embeddings of ingested group messages in SQLite and serves vector lookups.
 *
 * Embeddings are produced *asynchronously and best-effort*: ingestion never waits for the API
 * and never fails because of it. A message without an embedding is still retrievable through
 * full-text search; `RetrievalService` reports which messages were scored lexically only.
 */
@Injectable()
export class EmbeddingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmbeddingService.name);
  private queue: QueueItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private readonly backfilling = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly client: EmbeddingClient,
    private readonly messages: MessagesRepository,
  ) {}

  get enabled(): boolean {
    return this.client.configured;
  }

  get model(): string {
    return this.client.model_name;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Embeddings disabled (llm.apiKey not set); retrieval will be keyword-only');
      return;
    }
    this.messages.onInserted((sessionId, m) => this.enqueue({ sessionId, groupId: m.groupId, messageId: m.id, text: m.text }));
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ----------------------------------------------------------------- indexing

  private enqueue(item: QueueItem): void {
    if (item.text.trim().length < MIN_TEXT_LENGTH || this.queue.length >= MAX_QUEUE) return;
    this.queue.push(item);
    if (this.queue.length >= BATCH_SIZE) void this.flush();
    else this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
    this.timer.unref();
  }

  /** Embeds queued messages in batches. Never throws: a failed batch is logged and left for backfill. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0, BATCH_SIZE);
        try {
          const vectors = await this.client.embed(
            batch.map((b) => b.text),
            'document',
          );
          this.store(batch, vectors);
        } catch (e) {
          this.logger.warn(`Embedding batch of ${batch.length} failed (will be retried by backfill): ${(e as Error).message}`);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private store(batch: QueueItem[], vectors: number[][]): void {
    const db = this.database.connection;
    if (!this.database.isOpen) return;
    // The WHERE EXISTS guards against a message trimmed away while its embedding was in flight,
    // which would otherwise leave an orphan row the delete trigger can no longer clean up.
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO message_embeddings (session_id, group_id, message_id, model, dim, vector, created_at)
       SELECT @sessionId, @groupId, @messageId, @model, @dim, @vector, @now
       WHERE EXISTS (SELECT 1 FROM messages WHERE session_id = @sessionId AND group_id = @groupId AND id = @messageId)`,
    );
    db.transaction(() => {
      batch.forEach((item, i) => {
        const v = normalize(vectors[i]);
        stmt.run({ ...item, model: this.model, dim: v.length, vector: toBlob(v), now: Date.now() });
      });
    })();
  }

  /**
   * Queues embeddings for recent messages of a group that have none (history ingested before
   * embeddings were enabled, or batches that failed). Fire-and-forget and de-duplicated per group.
   */
  backfillGroup(sessionId: string, groupId: string, limit = 300): void {
    if (!this.enabled) return;
    const key = `${sessionId}|${groupId}`;
    if (this.backfilling.has(key)) return;
    this.backfilling.add(key);
    try {
      const rows = this.database.connection
        .prepare(
          `SELECT m.id AS id, m.text AS text FROM messages m
           LEFT JOIN message_embeddings e
             ON e.session_id = m.session_id AND e.group_id = m.group_id AND e.message_id = m.id AND e.model = ?
           WHERE m.session_id = ? AND m.group_id = ? AND e.message_id IS NULL
           ORDER BY m.timestamp DESC LIMIT ?`,
        )
        .all(this.model, sessionId, groupId, limit) as { id: string; text: string }[];
      for (const r of rows) this.enqueue({ sessionId, groupId, messageId: r.id, text: r.text });
    } finally {
      // Released after the queue drains so repeated queries do not re-enqueue the same rows.
      void this.flush().finally(() => this.backfilling.delete(key));
    }
  }

  // ------------------------------------------------------------------ lookups

  /** Embeds search queries in one call. Throws on API failure; the caller decides how to degrade. */
  async embedQueries(texts: string[]): Promise<Float32Array[]> {
    const vectors = await this.client.embed(texts, 'query');
    return vectors.map((v) => normalize(v));
  }

  /** All stored vectors of a group for the active model, keyed by message id. */
  loadGroupVectors(sessionId: string, groupId: string): Map<string, Float32Array> {
    const rows = this.database.connection
      .prepare('SELECT message_id, vector FROM message_embeddings WHERE session_id = ? AND group_id = ? AND model = ?')
      .all(sessionId, groupId, this.model) as { message_id: string; vector: Buffer }[];
    return new Map(rows.map((r) => [r.message_id, fromBlob(r.vector)]));
  }
}
