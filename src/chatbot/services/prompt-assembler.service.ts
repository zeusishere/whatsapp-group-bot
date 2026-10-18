import { Injectable } from '@nestjs/common';
import { Json, MessageRole, RetrievalLog } from '../models/types.js';
import { ANSWER_SYSTEM, PROMPTS, PromptTemplate, SMALLTALK_SYSTEM } from './prompts.js';
import { estimateTokens, truncateToTokens } from './text-utils.js';
import { WebSearchHit } from './web-search.service.js';

export interface AssembleInput {
  question: string;
  history: { role: MessageRole; content: string }[];
  /** The retrieval log whose chunks are admitted to (or dropped from) the prompt. Mutated in place. */
  retrieval: { log: RetrievalLog; texts: Map<string, string>; senders: Map<string, string> } | null;
  web_results: WebSearchHit[];
  tool_results: { tool: string; result: Json }[];
  /** `smalltalk` prompts carry no retrieved context. */
  kind: 'answer' | 'smalltalk';
  /** Token budget for retrieved context only. */
  context_budget_tokens: number;
  /** Hard cap on the number of chunks, whatever their size. */
  max_chunks: number;
}

export interface AssembledPrompt {
  system: string;
  prompt: string;
  template: PromptTemplate;
  included_chunk_ids: string[];
  /** Chunks that were relevant but did not fit (marked TOKEN_BUDGET_EXCEEDED). */
  budget_dropped_chunk_ids: string[];
  /** Chunks included only partially because they alone exceeded the budget. */
  truncated_chunk_ids: string[];
  web_result_count: number;
  web_results: WebSearchHit[];
  context_tokens: number;
  context_budget_tokens: number;
  prompt_tokens_estimate: number;
}

const HISTORY_ITEM_MAX_TOKENS = 200;
/** Fixed per-line cost of the "[n] name (date): " framing. */
const CHUNK_OVERHEAD_TOKENS = 12;

/**
 * Builds the model prompt and enforces the context-window budget.
 *
 * Web snippets are reserved first so a hybrid turn cannot spend the whole budget on chat
 * messages and drop the public-web evidence. Remaining budget is then filled with group
 * messages, best-first. Overflow (edge case): leftover relevant chunks are written back into
 * the retrieval log as `used_in_final_prompt: false` + `TOKEN_BUDGET_EXCEEDED`. The one
 * exception is when even the best chunk alone is larger than the leftover budget: it is
 * truncated rather than dropped.
 */
@Injectable()
export class PromptAssembler {
  assemble(input: AssembleInput): AssembledPrompt {
    const included: { id: string; sender: string; ts: number; text: string }[] = [];
    const budgetDropped: string[] = [];
    const truncated: string[] = [];
    let contextTokens = 0;

    const webBlock = input.kind === 'answer' ? formatWebResults(input.web_results) : '';
    const webTokens = webBlock ? estimateTokens(webBlock) : 0;
    const messageBudget = Math.max(1, input.context_budget_tokens - webTokens);

    if (input.kind === 'answer' && input.retrieval) {
      const { log, texts, senders } = input.retrieval;
      for (const chunk of log.retrieved_chunks) {
        chunk.used_in_final_prompt = false;
        if (chunk.drop_reason !== null) continue; // already rejected by retrieval (threshold, duplicate, policy)

        const full = texts.get(chunk.chunk_id) ?? chunk.content_preview;
        let text = neutralize(full);
        let cost = estimateTokens(text) + CHUNK_OVERHEAD_TOKENS;

        if (included.length >= input.max_chunks) {
          chunk.drop_reason = 'TOKEN_BUDGET_EXCEEDED';
          budgetDropped.push(chunk.chunk_id);
          continue;
        }
        if (included.length === 0 && cost > messageBudget) {
          text = truncateToTokens(text, Math.max(1, messageBudget - CHUNK_OVERHEAD_TOKENS));
          cost = estimateTokens(text) + CHUNK_OVERHEAD_TOKENS;
          truncated.push(chunk.chunk_id);
          chunk.metadata = { ...chunk.metadata, truncated_for_budget: true };
        } else if (contextTokens + cost > messageBudget) {
          chunk.drop_reason = 'TOKEN_BUDGET_EXCEEDED';
          budgetDropped.push(chunk.chunk_id);
          continue;
        }

        chunk.used_in_final_prompt = true;
        contextTokens += cost;
        included.push({
          id: chunk.chunk_id,
          sender: neutralize(senders.get(chunk.chunk_id) ?? 'member'),
          ts: Number(chunk.metadata.timestamp ?? 0),
          text,
        });
      }
      // The model reads the conversation in the order it happened, not in rank order.
      included.sort((a, b) => a.ts - b.ts);
    }

    contextTokens += webTokens;

    const sections: string[] = [];
    if (input.history.length) {
      sections.push(
        '<history>\n' +
          input.history
            .map((h) => `${h.role === 'USER' ? 'USER' : 'ASSISTANT'}: ${truncateToTokens(neutralize(h.content), HISTORY_ITEM_MAX_TOKENS)}`)
            .join('\n') +
          '\n</history>',
      );
    }
    if (input.kind === 'answer') {
      sections.push(
        '<context>\n' +
          (included.length
            ? included.map((c, i) => `[${i + 1}] ${c.sender} (${new Date(c.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC): ${c.text}`).join('\n')
            : '(no relevant messages found)') +
          '\n</context>',
      );
      if (webBlock) sections.push(webBlock);
    }
    for (const t of input.tool_results) {
      sections.push(`<tool_result name="${t.tool}">\n${neutralize(JSON.stringify(t.result))}\n</tool_result>`);
    }
    sections.push(`Latest message:\n${neutralize(input.question)}`);

    const template = input.kind === 'answer' ? PROMPTS.answerWithContext : PROMPTS.smalltalk;
    const system = input.kind === 'answer' ? ANSWER_SYSTEM : SMALLTALK_SYSTEM;
    const prompt = sections.join('\n\n');

    return {
      system,
      prompt,
      template,
      included_chunk_ids: included.map((c) => c.id),
      budget_dropped_chunk_ids: budgetDropped,
      truncated_chunk_ids: truncated,
      web_result_count: input.kind === 'answer' ? input.web_results.length : 0,
      web_results: input.kind === 'answer' ? input.web_results : [],
      context_tokens: contextTokens,
      context_budget_tokens: input.context_budget_tokens,
      prompt_tokens_estimate: estimateTokens(system) + estimateTokens(prompt),
    };
  }
}

const REFUSAL_PATTERN =
  /\b(?:i\s+)?(?:could(?:n't|\s+not)\s+find|cannot\s+find|can't\s+find|no\s+(?:relevant\s+|specific\s+)?(?:information|mention|results?|details)|don't\s+have\s+(?:enough\s+|any\s+|specific\s+)?(?:information|context|access))\b/i;

const MAX_FALLBACK_CITATIONS = 3;

/**
 * Ensures replies grounded in `<web_results>` carry clickable citations on WhatsApp even when
 * the model omits the `Sources:` block or only writes `[1]` inline without the URL.
 */
export function appendWebCitations(reply: string, webResults: WebSearchHit[]): string {
  const trimmed = reply.trim();
  if (!trimmed || !webResults.length || REFUSAL_PATTERN.test(trimmed)) return trimmed;

  const citedIndices: number[] = [];
  for (const m of trimmed.matchAll(/\[(\d+)\]/g)) {
    const idx = Number(m[1]);
    if (idx >= 1 && idx <= webResults.length && !citedIndices.includes(idx)) {
      citedIndices.push(idx);
    }
  }

  const candidates = citedIndices.length
    ? citedIndices.map((idx) => ({ index: idx, hit: webResults[idx - 1] }))
    : webResults.slice(0, MAX_FALLBACK_CITATIONS).map((hit, i) => ({ index: i + 1, hit }));

  if (!citedIndices.length && webResults.some((h) => h.url && trimmed.includes(h.url))) {
    return trimmed;
  }

  const seenUrls = new Set<string>();
  const missingLines: string[] = [];
  for (const { index, hit } of candidates) {
    const url = hit.url?.trim();
    if (!url || seenUrls.has(url) || trimmed.includes(url)) continue;
    seenUrls.add(url);
    const title = neutralize(hit.title ?? '').replace(/\s+/g, ' ').trim();
    missingLines.push(title && title !== url ? `[${index}] ${title} - ${url}` : `[${index}] ${url}`);
  }

  if (!missingLines.length) return trimmed;
  if (/(?:^|\n)Sources:\s*$/im.test(trimmed)) {
    return `${trimmed}\n${missingLines.join('\n')}`;
  }
  return `${trimmed}\n\nSources:\n${missingLines.join('\n')}`;
}

function formatWebResults(hits: WebSearchHit[]): string {
  if (!hits.length) return '';
  const lines = hits.map((h, i) => {
    const title = neutralize(h.title) || h.url;
    const snippet = neutralize(h.content);
    return `[${i + 1}] ${title} (${h.url}): ${snippet}`;
  });
  return `<web_results>\n${lines.join('\n')}\n</web_results>`;
}

/** Removes our structural tags from untrusted text so a message cannot close <context> and inject its own. */
export function neutralize(text: string): string {
  return text.replace(/<\/?\s*(context|history|tool_result|web_results)\b[^>]*>/gi, '');
}
