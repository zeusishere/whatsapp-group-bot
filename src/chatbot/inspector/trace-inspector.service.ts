import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../../auth/auth.types.js';
import {
  ConversationTurn,
  DecisionSpan,
  Message,
  RetrievalLog,
  RetrievedChunk,
  StepType,
} from '../models/types.js';
import { TraceRepository } from '../tracing/trace.repository.js';
import { generateMermaidTrace } from './mermaid.js';

export type TimelineStage =
  | 'User Input'
  | 'Query Analysis'
  | 'Context Retrieval'
  | 'Decision/Routing'
  | 'Tool Calls'
  | 'Prompt Assembly'
  | 'Final Reply';

export interface TimelineItem {
  stage: TimelineStage;
  sequence_order: number | null;
  span_id: string | null;
  step_type: StepType | null;
  status: string | null;
  duration_ms: number | null;
  summary: string;
  kept_chunks?: RetrievedChunk[];
  dropped_chunks?: RetrievedChunk[];
}

export interface SpanTreeNode extends DecisionSpan {
  children: SpanTreeNode[];
}

export interface DagNode {
  id: string;
  kind: 'user_message' | 'span' | 'bot_message';
  label: string;
}

export interface DagEdge {
  from: string;
  to: string;
  kind: 'parent' | 'sequence' | 'retry' | 'data';
}

export interface TraceView {
  turn: ConversationTurn;
  timeline: TimelineItem[];
  tree: SpanTreeNode[];
  dag: { nodes: DagNode[]; edges: DagEdge[] };
  retrievals: RetrievalLog[];
  messages: Message[];
  mermaid: string;
}

const STAGE_OF: Record<StepType, TimelineStage> = {
  QUERY_REWRITE: 'Query Analysis',
  INTENT_ROUTER: 'Decision/Routing',
  GUARDRAIL_CHECK: 'Decision/Routing',
  CONTEXT_RETRIEVAL: 'Context Retrieval',
  WEB_SEARCH: 'Context Retrieval',
  TOOL_EXECUTION: 'Tool Calls',
  PROMPT_ASSEMBLY: 'Prompt Assembly',
  LLM_GENERATION: 'Final Reply',
  FALLBACK_HANDLER: 'Final Reply',
  LOW_CONFIDENCE_CONTEXT: 'Context Retrieval',
};

/**
 * Reconstructs a turn as a timeline, a parent/child tree, a DAG and a Mermaid flowchart.
 * Ownership is checked through the conversation thread: unknown ids and other users' turns
 * both become 404 so turn ids cannot be probed.
 */
@Injectable()
export class TraceInspectorService {
  constructor(private readonly repo: TraceRepository) {}

  inspectTurn(turnId: string, user: AuthUser): TraceView {
    const turn = this.repo.getTurn(turnId);
    if (!turn) throw new NotFoundException(`Turn ${turnId} not found`);
    this.assertAccessible(turn.session_id, user);
    return this.view(turn);
  }

  inspectMessage(messageId: string, user: AuthUser): TraceView {
    const turn = this.repo.getTurnByMessage(messageId);
    if (!turn) throw new NotFoundException(`Message ${messageId} not found`);
    this.assertAccessible(turn.session_id, user);
    return this.view(turn);
  }

  generateMermaidTrace(turnId: string, user: AuthUser): string {
    return this.inspectTurn(turnId, user).mermaid;
  }

  private assertAccessible(sessionId: string, user: AuthUser): void {
    const thread = this.repo.getThread(sessionId);
    if (!thread || (user.role !== 'admin' && thread.owner_id !== user.id)) {
      throw new NotFoundException('Turn not found');
    }
  }

  private view(turn: ConversationTurn): TraceView {
    const spans = this.repo.getSpans(turn.turn_id);
    const retrievals = this.repo.getRetrievalLogs(turn.turn_id);
    const messages = this.repo.getMessagesForTurn(turn.turn_id);
    return {
      turn,
      timeline: this.timeline(turn, spans, retrievals, messages),
      tree: this.tree(spans),
      dag: this.dag(turn, spans, retrievals),
      retrievals,
      messages,
      mermaid: generateMermaidTrace({ turn, spans, retrievals }),
    };
  }

  private timeline(turn: ConversationTurn, spans: DecisionSpan[], retrievals: RetrievalLog[], messages: Message[]): TimelineItem[] {
    const items: TimelineItem[] = [];
    const user = messages.find((m) => m.role === 'USER');
    items.push({
      stage: 'User Input',
      sequence_order: null,
      span_id: null,
      step_type: null,
      status: null,
      duration_ms: null,
      summary: user?.content ?? turn.user_input_raw,
    });

    for (const s of spans) {
      const retrieval = retrievals.find((r) => r.span_id === s.span_id);
      const item: TimelineItem = {
        stage: STAGE_OF[s.step_type],
        sequence_order: s.sequence_order,
        span_id: s.span_id,
        step_type: s.step_type,
        status: s.status,
        duration_ms: s.duration_ms,
        summary: s.rationale ?? s.step_type,
      };
      if (retrieval) {
        item.kept_chunks = retrieval.retrieved_chunks.filter((c) => c.used_in_final_prompt);
        item.dropped_chunks = retrieval.retrieved_chunks.filter((c) => !c.used_in_final_prompt);
      }
      items.push(item);
    }

    const bot = messages.find((m) => m.role === 'ASSISTANT');
    if (bot || turn.bot_reply_raw) {
      items.push({
        stage: 'Final Reply',
        sequence_order: null,
        span_id: null,
        step_type: null,
        status: turn.status,
        duration_ms: turn.total_latency_ms,
        summary: bot?.content ?? turn.bot_reply_raw ?? '(no reply)',
      });
    }
    return items;
  }

  private tree(spans: DecisionSpan[]): SpanTreeNode[] {
    const nodes = new Map<string, SpanTreeNode>(spans.map((s) => [s.span_id, { ...s, children: [] }]));
    const roots: SpanTreeNode[] = [];
    for (const s of spans) {
      const node = nodes.get(s.span_id)!;
      const parent = s.parent_span_id ? nodes.get(s.parent_span_id) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  private dag(turn: ConversationTurn, spans: DecisionSpan[], retrievals: RetrievalLog[]): { nodes: DagNode[]; edges: DagEdge[] } {
    const nodes: DagNode[] = [
      { id: `msg:${turn.user_message_id}`, kind: 'user_message', label: 'USER' },
      ...spans.map((s) => ({ id: s.span_id, kind: 'span' as const, label: `${s.sequence_order} ${s.step_type}` })),
    ];
    if (turn.bot_message_id) nodes.push({ id: `msg:${turn.bot_message_id}`, kind: 'bot_message', label: 'ASSISTANT' });

    const edges: DagEdge[] = [];
    if (spans[0]) edges.push({ from: `msg:${turn.user_message_id}`, to: spans[0].span_id, kind: 'sequence' });

    for (const s of spans) {
      if (s.parent_span_id) edges.push({ from: s.parent_span_id, to: s.span_id, kind: 'parent' });
    }
    for (let i = 0; i < spans.length - 1; i++) {
      const a = spans[i];
      const b = spans[i + 1];
      if (a.parent_span_id !== b.parent_span_id) continue;
      edges.push({
        from: a.span_id,
        to: b.span_id,
        kind: a.status === 'RETRYING' && a.step_type === b.step_type ? 'retry' : 'sequence',
      });
    }
    const retrievalSpan = spans.find((s) => s.step_type === 'CONTEXT_RETRIEVAL' && retrievals.some((r) => r.span_id === s.span_id));
    const webSpan = spans.find((s) => s.step_type === 'WEB_SEARCH');
    const assembly = spans.find((s) => s.step_type === 'PROMPT_ASSEMBLY');
    if (retrievalSpan && assembly) edges.push({ from: retrievalSpan.span_id, to: assembly.span_id, kind: 'data' });
    if (webSpan && assembly) edges.push({ from: webSpan.span_id, to: assembly.span_id, kind: 'data' });

    if (turn.bot_message_id && spans.length) {
      edges.push({ from: spans[spans.length - 1].span_id, to: `msg:${turn.bot_message_id}`, kind: 'sequence' });
    }
    return { nodes, edges };
  }
}
