import { ConversationTurn, DecisionSpan, RetrievalLog } from '../models/types.js';

export interface MermaidInput {
  turn: ConversationTurn;
  spans: DecisionSpan[];
  retrievals: RetrievalLog[];
}

/**
 * Converts a recorded turn into a Mermaid `flowchart TD` string a developer can paste into
 * mermaid.live (or any renderer) to see the decision path.
 *
 * Labels are quoted and escaped so step types, statuses and durations cannot break the diagram.
 * Retries and fallbacks use dashed edges. No explicit colors or styles: the renderer theme
 * handles those.
 */
export function generateMermaidTrace(input: MermaidInput): string {
  const { turn, spans, retrievals } = input;
  const lines: string[] = ['flowchart TD'];

  const userId = 'user_msg';
  const botId = 'bot_msg';
  lines.push(`  ${userId}["${esc(`USER: ${clip(turn.user_input_raw, 60)}`)}"]`);

  const spanNode = (s: DecisionSpan) => `s_${s.span_id}`;
  for (const s of spans) {
    const retrieval = retrievals.find((r) => r.span_id === s.span_id);
    const extra = retrieval
      ? ` kept=${retrieval.retrieved_chunks.filter((c) => c.used_in_final_prompt).length}` +
        ` dropped=${retrieval.retrieved_chunks.filter((c) => !c.used_in_final_prompt).length}`
      : '';
    lines.push(`  ${spanNode(s)}["${esc(`${s.sequence_order} ${s.step_type} ${s.status} ${s.duration_ms}ms${extra}`)}"]`);
  }

  const replyLabel = turn.bot_reply_raw
    ? `ASSISTANT (${turn.status}): ${clip(turn.bot_reply_raw, 60)}`
    : `NO REPLY (${turn.status})`;
  lines.push(`  ${botId}["${esc(replyLabel)}"]`);

  const first = spans[0];
  if (first) lines.push(`  ${userId} --> ${spanNode(first)}`);
  else lines.push(`  ${userId} --> ${botId}`);

  const byId = new Map(spans.map((s) => [s.span_id, s]));
  for (const s of spans) {
    if (s.parent_span_id && byId.has(s.parent_span_id)) {
      lines.push(`  ${spanNode(byId.get(s.parent_span_id)!)} --> ${spanNode(s)}`);
    }
  }

  for (let i = 0; i < spans.length - 1; i++) {
    const a = spans[i];
    const b = spans[i + 1];
    if (a.parent_span_id !== b.parent_span_id) continue;
    const dashed = a.status === 'RETRYING' || a.status === 'FALLBACK' || a.step_type === b.step_type;
    lines.push(`  ${spanNode(a)} ${dashed ? '-.->' : '-->'} ${spanNode(b)}`);
  }

  const retrievalSpan = spans.find((s) => s.step_type === 'CONTEXT_RETRIEVAL');
  const webSpan = spans.find((s) => s.step_type === 'WEB_SEARCH');
  const webFetchSpan = spans.find((s) => s.step_type === 'WEB_FETCH');
  const assembly = spans.find((s) => s.step_type === 'PROMPT_ASSEMBLY');
  if (retrievalSpan && assembly) {
    lines.push(`  ${spanNode(retrievalSpan)} -.-> ${spanNode(assembly)}`);
  }
  if (webFetchSpan && assembly) {
    lines.push(`  ${spanNode(webFetchSpan)} -.-> ${spanNode(assembly)}`);
  } else if (webSpan && assembly) {
    lines.push(`  ${spanNode(webSpan)} -.-> ${spanNode(assembly)}`);
  }

  const last = spans[spans.length - 1];
  if (last) lines.push(`  ${spanNode(last)} --> ${botId}`);

  return `${lines.join('\n')}\n`;
}

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/** Makes a string safe as a quoted Mermaid node label. */
function esc(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/\[/g, '(').replace(/\]/g, ')').replace(/[<>]/g, '');
}
