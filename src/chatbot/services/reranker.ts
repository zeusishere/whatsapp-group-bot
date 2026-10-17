export interface RerankCandidate {
  id: string;
  /** Reciprocal-rank-fusion score across all retrievers and queries. */
  rrf: number;
  lexical_coverage: number;
  /** Epoch ms of the underlying message. */
  timestamp: number;
  /** True when this candidate is the message the user is replying to. */
  quoted: boolean;
}

/**
 * Second-stage ordering of retrieved candidates. An abstract class so a cross-encoder (or an
 * LLM judge) can be dropped in through DI without touching `RetrievalService`.
 */
export abstract class Reranker {
  /** Returns a score in [0, 1] per candidate id; higher is better. */
  abstract rerank(query: string, candidates: RerankCandidate[], now: number): Map<string, number>;
}

const RECENCY_HALF_LIFE_MS = 7 * 24 * 3600 * 1000;

/**
 * Heuristic reranker (no model call): relevance from fusion rank, boosted by exact keyword
 * coverage and by recency, because in a group chat the newest discussion of a topic is
 * usually the one people mean. This is NOT a cross-encoder.
 */
export class HeuristicReranker extends Reranker {
  rerank(_query: string, candidates: RerankCandidate[], now: number): Map<string, number> {
    const maxRrf = Math.max(...candidates.map((c) => c.rrf), Number.EPSILON);
    const out = new Map<string, number>();
    for (const c of candidates) {
      const age = Math.max(0, now - c.timestamp);
      const recency = Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
      const score = 0.5 * (c.rrf / maxRrf) + 0.2 * c.lexical_coverage + 0.15 * recency + 0.15 * (c.quoted ? 1 : 0);
      out.set(c.id, Math.round(score * 10_000) / 10_000);
    }
    return out;
  }
}
