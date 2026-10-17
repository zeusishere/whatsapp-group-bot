import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { performance } from 'node:perf_hooks';
import { AppConfig } from '../../config/env.schema.js';
import { DatabaseService } from '../../database/database.service.js';
import { MessagesRepository, StoredMessage } from '../../messages/messages.repository.js';
import { RetrievedChunk, SearchStrategy } from '../models/types.js';
import { TraceService } from '../tracing/trace.service.js';
import { EmbeddingService } from './embedding.service.js';
import { Reranker } from './reranker.js';
import { dedupeKey, keywords, lexicalCoverage, toFtsQuery } from './text-utils.js';
import { dot } from './vector-math.js';

/** Standard reciprocal-rank-fusion constant: damps the advantage of rank 1 over rank 2. */
const RRF_K = 60;

export interface RetrievalRequest {
  /** The WhatsApp device session that owns the corpus. */
  device_session_id: string;
  group_id: string;
  raw_query: string;
  rewritten_queries: string[];
  /** Messages that must not be retrieved (the question itself is already stored in the corpus). */
  exclude_message_ids?: string[];
  /** The message the user is replying to, if any; boosted by the reranker. */
  quoted_message_id?: string | null;
  now?: number;
}

export interface RetrievalOutcome {
  search_strategy: SearchStrategy;
  /** Human-readable facts about how the search ran (degradations, empty corpus, ...). */
  notes: string[];
  /** Every candidate, best first. `drop_reason` is set on the ones filtered out here. */
  chunks: RetrievedChunk[];
  /** Full text of each chunk, for prompt assembly. Never persisted (the log only holds previews). */
  texts: Map<string, string>;
  /** Display names of the senders, for prompt assembly. */
  senders: Map<string, string>;
  latency_ms: number;
}

interface Candidate {
  id: string;
  message: StoredMessage;
  rrf: number;
  bm25: number | null;
  cosine: number | null;
  coverage: number;
}

/**
 * Hybrid retrieval over the ingested messages of one WhatsApp group:
 *
 *   FTS5 BM25  ┐
 *              ├─> reciprocal-rank fusion -> filters (policy, threshold, duplicates) -> rerank
 *   cosine     ┘
 *
 * The service never decides what the LLM sees; it returns every candidate with a verdict
 * (`drop_reason`) so the audit log shows what was found and why each piece was kept or discarded.
 * Prompt budget enforcement happens later, in `PromptAssembler`.
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);
  private readonly cfg: AppConfig['bot'];

  constructor(
    private readonly database: DatabaseService,
    private readonly messages: MessagesRepository,
    private readonly embeddings: EmbeddingService,
    private readonly reranker: Reranker,
    private readonly trace: TraceService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.cfg = config.get('bot', { infer: true });
  }

  async retrieve(req: RetrievalRequest): Promise<RetrievalOutcome> {
    const t0 = performance.now();
    const now = req.now ?? Date.now();
    const notes: string[] = [];
    const exclude = new Set(req.exclude_message_ids ?? []);

    const queries = [...new Set([req.raw_query, ...req.rewritten_queries].map((q) => q.trim()).filter(Boolean))].slice(0, 4);
    const termsPerQuery = queries.map((q) => keywords(q));
    const allTerms = [...new Set(termsPerQuery.flat())];

    // ---- lexical retriever (BM25) -------------------------------------------------------------
    const bm25Lists: { id: string; score: number }[][] = termsPerQuery.map((terms) => this.bm25(req, terms, exclude));
    const bm25Used = bm25Lists.some((l) => l.length > 0);
    if (!allTerms.length) notes.push('NO_KEYWORDS: the query has no content words; keyword search was skipped');

    // ---- vector retriever ---------------------------------------------------------------------
    let vectorLists: { id: string; score: number }[][] = [];
    let vectors: Map<string, Float32Array> | null = null;
    let queryVectors: Float32Array[] = [];
    let vectorUsed = false;
    if (this.embeddings.enabled && queries.length) {
      // Anything ingested without an embedding is indexed in the background for next time.
      this.embeddings.backfillGroup(req.device_session_id, req.group_id);
      try {
        queryVectors = await this.embeddings.embedQueries(queries);
        vectors = this.embeddings.loadGroupVectors(req.device_session_id, req.group_id);
        vectorLists = queryVectors.map((qv) => this.cosineTop(qv, vectors!, exclude));
        vectorUsed = vectors.size > 0;
        if (!vectorUsed) notes.push('NO_EMBEDDINGS: no message of this group has an embedding yet; keyword search only');
      } catch (e) {
        // Degrade rather than fail the turn: BM25 alone is still a valid (weaker) search.
        notes.push(`EMBEDDING_UNAVAILABLE: ${(e as Error).message}; fell back to keyword search`);
        this.logger.warn(`Embedding lookup failed, using BM25 only: ${(e as Error).message}`);
      }
    } else if (!this.embeddings.enabled) {
      notes.push('EMBEDDINGS_DISABLED: llm.apiKey is not set; keyword search only');
    }

    const strategy: SearchStrategy = bm25Used && vectorUsed ? 'HYBRID' : vectorUsed ? 'VECTOR_COSINE' : 'BM25';

    // ---- fuse ---------------------------------------------------------------------------------
    const rrf = new Map<string, number>();
    const bm25Best = new Map<string, number>();
    for (const list of bm25Lists) {
      list.forEach((hit, rank) => {
        rrf.set(hit.id, (rrf.get(hit.id) ?? 0) + 1 / (RRF_K + rank + 1));
        bm25Best.set(hit.id, Math.max(bm25Best.get(hit.id) ?? 0, hit.score));
      });
    }
    for (const list of vectorLists) {
      list.forEach((hit, rank) => rrf.set(hit.id, (rrf.get(hit.id) ?? 0) + 1 / (RRF_K + rank + 1)));
    }

    const topIds = [...rrf.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.cfg.candidatePoolSize)
      .map(([id]) => id);
    const byId = new Map(this.messages.getByIds(req.device_session_id, req.group_id, topIds).map((m) => [m.id, m]));

    const candidates: Candidate[] = [];
    for (const id of topIds) {
      const message = byId.get(id);
      if (!message) continue; // trimmed between search and load
      const vec = vectors?.get(id);
      // Best similarity over all query formulations (the raw query and its rewrites).
      const cosine = vec && queryVectors.length ? Math.max(...queryVectors.map((q) => dot(q, vec))) : null;
      candidates.push({
        id,
        message,
        rrf: rrf.get(id) ?? 0,
        bm25: bm25Best.get(id) ?? null,
        cosine,
        coverage: Math.max(0, ...termsPerQuery.map((terms) => lexicalCoverage(terms, message.text))),
      });
    }

    // ---- rerank -------------------------------------------------------------------------------
    const rerankScores = this.reranker.rerank(
      req.raw_query,
      candidates.map((c) => ({
        id: c.id,
        rrf: c.rrf,
        lexical_coverage: c.coverage,
        timestamp: c.message.timestamp,
        quoted: c.id === req.quoted_message_id,
      })),
      now,
    );
    candidates.sort((a, b) => (rerankScores.get(b.id) ?? 0) - (rerankScores.get(a.id) ?? 0));

    // ---- verdicts (in rank order, so a duplicate is judged against the better-ranked copy) ----
    const seen = new Set<string>();
    const texts = new Map<string, string>();
    const senders = new Map<string, string>();
    const chunks: RetrievedChunk[] = candidates.map((c) => {
      const text = c.message.text;
      const similarity = c.cosine ?? c.coverage;
      const threshold = c.cosine !== null ? this.cfg.minSimilarity : this.cfg.minLexicalCoverage;

      let drop: RetrievedChunk['drop_reason'] = null;
      if (this.trace.redactor.containsSecret(text)) drop = 'POLICY_FILTERED'; // safety first: never forward credentials to the model
      else if (similarity < threshold) drop = 'BELOW_THRESHOLD';
      else {
        const key = dedupeKey(text);
        if (seen.has(key)) drop = 'DUPLICATE';
        else seen.add(key);
      }

      texts.set(c.id, text);
      senders.set(c.id, c.message.senderName ?? 'member');
      return {
        chunk_id: c.id,
        doc_id: `${req.device_session_id}:${req.group_id}:${c.id}`,
        similarity_score: round(similarity),
        rerank_score: rerankScores.get(c.id) ?? null,
        content_preview: text,
        metadata: {
          source: 'whatsapp_group',
          device_session_id: req.device_session_id,
          group_id: req.group_id,
          sender_name: c.message.senderName,
          timestamp: c.message.timestamp,
          is_bot: c.message.isBot,
          quoted_message_id: c.message.quotedMessageId,
        },
        used_in_final_prompt: false, // decided by PromptAssembler
        drop_reason: drop,
        scores: {
          cosine: c.cosine === null ? null : round(c.cosine),
          bm25: c.bm25 === null ? null : round(c.bm25),
          lexical_coverage: round(c.coverage),
          rrf: round(c.rrf, 6),
        },
      };
    });

    if (!chunks.length) notes.push('NO_CANDIDATES: nothing matched the query in this chat');

    return { search_strategy: strategy, notes, chunks, texts, senders, latency_ms: Math.round(performance.now() - t0) };
  }

  // ---------------------------------------------------------------- retrievers

  /** BM25 over the FTS index; scores are sign-flipped so higher is better. */
  private bm25(req: RetrievalRequest, terms: string[], exclude: Set<string>): { id: string; score: number }[] {
    const match = toFtsQuery(terms);
    if (!match) return [];
    try {
      const rows = this.database.connection
        .prepare(
          `SELECT message_id, -bm25(messages_fts) AS score FROM messages_fts
           WHERE messages_fts MATCH ? AND session_id = ? AND group_id = ?
           ORDER BY bm25(messages_fts) LIMIT ?`,
        )
        .all(match, req.device_session_id, req.group_id, this.cfg.candidatePoolSize + exclude.size) as {
        message_id: string;
        score: number;
      }[];
      return rows.filter((r) => !exclude.has(r.message_id)).slice(0, this.cfg.candidatePoolSize).map((r) => ({ id: r.message_id, score: r.score }));
    } catch (e) {
      // Quoting makes syntax errors unlikely, but an index problem must not sink the turn.
      this.logger.warn(`FTS query failed: ${(e as Error).message}`);
      return [];
    }
  }

  private cosineTop(query: Float32Array, vectors: Map<string, Float32Array>, exclude: Set<string>): { id: string; score: number }[] {
    const hits: { id: string; score: number }[] = [];
    for (const [id, v] of vectors) {
      if (!exclude.has(id)) hits.push({ id, score: dot(query, v) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, this.cfg.candidatePoolSize);
  }
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
