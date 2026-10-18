import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../../config/configuration.js';
import { AppConfig, DEFAULT_CONFIG } from '../../config/env.schema.js';
import { SCHEMA_SQL } from '../../database/schema.sql.js';
import { DatabaseService } from '../../database/database.service.js';
import { MessagesRepository } from '../../messages/messages.repository.js';
import { GeminiEmbeddingClient, GeminiLlmClient, GeminiSdk } from '../llm/gemini.client.js';
import { EmbeddingClient, LlmClient, LlmRequest, LlmResponse } from '../llm/llm-client.js';
import { TRACE_SCHEMA_SQL } from '../models/trace.schema.js';
import { TurnStatus } from '../models/types.js';
import { ChatPipelineService } from '../pipeline/chat-pipeline.service.js';
import { DecisionEngine } from '../services/decision-engine.service.js';
import { EmbeddingService } from '../services/embedding.service.js';
import { PromptAssembler } from '../services/prompt-assembler.service.js';
import { Route, SearchSource } from '../services/prompts.js';
import { HeuristicReranker } from '../services/reranker.js';
import { RetrievalService } from '../services/retrieval.service.js';
import { keywords } from '../services/text-utils.js';
import { ToolRegistry } from '../services/tool.registry.js';
import { WebSearchService } from '../services/web-search.service.js';
import { configService } from '../testing/harness.js';
import { TraceRepository } from '../tracing/trace.repository.js';
import { TraceService } from '../tracing/trace.service.js';
import {
  EVAL_CASES,
  EVAL_GROUP_ID,
  EVAL_SEED_MESSAGES,
  EvalCase,
  EvalCategory,
} from './eval-dataset.js';

export interface EvalCaseResult {
  id: string;
  category: EvalCategory;
  description: string;
  question: string;
  expectedRoute: Route | 'guardrail_blocked';
  actualRoute: Route | 'guardrail_blocked' | null;
  routeMatch: boolean;
  expectedSearchSource: SearchSource | null;
  actualSearchSource: SearchSource | null;
  sourceMatch: boolean;
  expectedStatus: TurnStatus;
  actualStatus: TurnStatus;
  statusMatch: boolean;
  groundednessPass: boolean;
  missingExpected: string[];
  forbiddenFound: string[];
  passed: boolean;
  reply: string | null;
  latencyMs: number;
}

export interface EvalCategorySummary {
  category: EvalCategory;
  total: number;
  passed: number;
  passRate: number;
}

export interface EvalSummaryReport {
  mode: 'offline' | 'live';
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  avgLatencyMs: number;
  byCategory: EvalCategorySummary[];
  results: EvalCaseResult[];
}

export interface RunEvalOptions {
  mode?: 'offline' | 'live';
  cases?: EvalCase[];
}

const VECTOR_DIM = 512;

/**
 * High-dimensional deterministic word-hash embedding client for offline evaluation:
 * queries that share domain keywords with a message achieve high cosine similarity, while
 * unrelated queries do not collide into false-positive matches.
 */
class EvalOfflineEmbeddings extends EmbeddingClient {
  readonly model_name = 'eval-hash-512';
  readonly configured = true;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const vec = new Array<number>(VECTOR_DIM).fill(0);
      const terms = keywords(t);
      for (const word of terms) {
        let h = 2166136261;
        for (let i = 0; i < word.length; i++) {
          h ^= word.charCodeAt(i);
          h = Math.imul(h, 16777619) >>> 0;
        }
        vec[h % VECTOR_DIM] += 1;
      }
      const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
      return vec.map((x) => x / norm);
    });
  }
}

class EvalScriptedLlm extends LlmClient {
  readonly model_name = 'eval-scripted-llm';
  readonly configured = true;
  activeCase: EvalCase | null = null;

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const tc = this.activeCase;
    if (!tc) {
      throw new Error('EvalScriptedLlm invoked without an active EvalCase');
    }

    if (req.json) {
      const schemaStr = JSON.stringify(req.jsonSchema ?? {});
      if (schemaStr.includes('"queries"')) {
        const queries = tc.scriptedRewrite ?? [tc.question];
        return {
          text: JSON.stringify({ queries }),
          usage: { prompt_tokens: 24, completion_tokens: 10, total_tokens: 34 },
          model: this.model_name,
          finish_reason: 'STOP',
        };
      }

      const route = tc.expectedRoute === 'guardrail_blocked' ? 'answer_from_context' : tc.expectedRoute;
      const search_source = tc.expectedSearchSource ?? 'none';
      return {
        text: JSON.stringify({
          route,
          search_source,
          confidence: 0.95,
          rationale: `Eval router: ${tc.description}`,
        }),
        usage: { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 },
        model: this.model_name,
        finish_reason: 'STOP',
      };
    }

    return {
      text: tc.scriptedAnswer ?? '',
      usage: { prompt_tokens: 64, completion_tokens: 28, total_tokens: 92 },
      model: this.model_name,
      finish_reason: 'STOP',
    };
  }
}

function buildEvalConfig(mode: 'offline' | 'live'): AppConfig {
  if (mode === 'live') {
    const liveCfg = loadConfig();
    return {
      ...liveCfg,
      database: { ...liveCfg.database, path: ':memory:' },
    };
  }
  return {
    ...DEFAULT_CONFIG,
    auth: { ...DEFAULT_CONFIG.auth, jwtSecret: 'eval-secret-key-at-least-32-chars!!' },
    llm: { ...DEFAULT_CONFIG.llm, apiKey: 'eval-offline-key' },
    bot: {
      ...DEFAULT_CONFIG.bot,
      minSimilarity: 0.35,
      minLexicalCoverage: 0.34,
    },
    webSearch: {
      ...DEFAULT_CONFIG.webSearch,
      apiKey: 'tvly-eval-offline-key',
      maxResults: 5,
      extractTopN: 2,
    },
    database: { ...DEFAULT_CONFIG.database, path: ':memory:' },
  };
}

export async function runEvaluation(options: RunEvalOptions = {}): Promise<EvalSummaryReport> {
  const mode = options.mode ?? 'offline';
  const cases = options.cases ?? EVAL_CASES;
  const cfg = buildEvalConfig(mode);
  const cfgService = configService(cfg);

  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.exec(TRACE_SCHEMA_SQL);

  const now = Date.now();
  const userId = '11111111-1111-4111-8111-111111111111';
  const deviceSessionId = '22222222-2222-4222-8222-222222222222';
  db.prepare(
    `INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, 'eval@bot.local', 'x', 'admin', ?)`,
  ).run(userId, now);
  db.prepare(
    `INSERT INTO sessions (id, owner_id, status, desired_state, jid, lid, created_at, updated_at)
     VALUES (?, ?, 'connected', 'connected', '919063108886@s.whatsapp.net', '239071553126652@lid', ?, ?)`,
  ).run(deviceSessionId, userId, now, now);

  const database = { connection: db, isOpen: true } as DatabaseService;
  const repo = new TraceRepository(database);
  const messages = new MessagesRepository(database, cfgService);
  const trace = new TraceService(repo, cfgService);
  const thread = repo.getOrCreateBoundThread(userId, deviceSessionId, EVAL_GROUP_ID);

  const scriptedLlm = new EvalScriptedLlm();
  const sdk = mode === 'live' ? new GeminiSdk(cfgService) : null;
  const llm: LlmClient = mode === 'live' ? new GeminiLlmClient(sdk!, cfgService) : scriptedLlm;
  const embedClient: EmbeddingClient =
    mode === 'live' ? new GeminiEmbeddingClient(sdk!, cfgService) : new EvalOfflineEmbeddings();

  const embeddings = new EmbeddingService(database, embedClient, messages);
  embeddings.onModuleInit();
  for (const seed of EVAL_SEED_MESSAGES) {
    messages.insert(deviceSessionId, seed);
  }
  await embeddings.flush();
  embeddings.onModuleDestroy();

  const retrieval = new RetrievalService(
    database,
    messages,
    embeddings,
    new HeuristicReranker(),
    trace,
    cfgService,
  );
  const tools = new ToolRegistry(messages);
  const decisions = new DecisionEngine(llm, tools, cfgService);
  const assembler = new PromptAssembler();
  const web = new WebSearchService(cfgService);
  const pipeline = new ChatPipelineService(
    decisions,
    retrieval,
    assembler,
    web,
    cfgService,
    messages,
  );

  const originalFetch = globalThis.fetch;
  const results: EvalCaseResult[] = [];

  try {
    for (const tc of cases) {
      scriptedLlm.activeCase = tc;

      if (mode === 'offline') {
        const hits = tc.mockWebResults ?? [];
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/extract')) {
            return {
              ok: true,
              json: async () => ({
                results: hits
                  .filter((h) => h.extracted)
                  .map((h) => ({ url: h.url, raw_content: h.extracted })),
              }),
              text: async () => '',
            };
          }
          return {
            ok: true,
            json: async () => ({
              results: hits.map((h) => ({
                title: h.title,
                url: h.url,
                content: h.content,
                score: h.score,
              })),
            }),
            text: async () => '',
          };
        }) as unknown as typeof fetch;
      }

      const t0 = performance.now();
      const claim = trace.claim({
        session_id: thread.session_id,
        idempotency_key: `eval:${tc.id}`,
        user_input_raw: tc.question,
        user_external_id: null,
      });
      if (!claim.created) {
        throw new Error(`Duplicate evaluation key for ${tc.id}`);
      }

      const turn = await claim.collector.run((collector) =>
        pipeline.execute(collector, {
          thread,
          question: tc.question,
          history: [],
          inbound_external_id: null,
          quoted_message_id: null,
        }),
      );
      const latencyMs = Math.round(performance.now() - t0);

      const spans = repo.getSpans(turn.turn_id);
      const guardSpan = [...spans].reverse().find((s) => s.step_type === 'GUARDRAIL_CHECK');
      const routerSpan = [...spans].reverse().find((s) => s.step_type === 'INTENT_ROUTER');

      let actualRoute: Route | 'guardrail_blocked' | null = null;
      let actualSearchSource: SearchSource | null = null;

      if (guardSpan && (guardSpan.decision_outcome as { allowed?: boolean }).allowed === false) {
        actualRoute = 'guardrail_blocked';
        actualSearchSource = null;
      } else if (routerSpan) {
        const outcome = routerSpan.decision_outcome as {
          selected_route?: Route;
          search_source?: SearchSource;
        };
        actualRoute = outcome.selected_route ?? null;
        actualSearchSource = outcome.search_source ?? null;
      }

      const replyText = turn.bot_reply_raw ?? '';
      const replyLower = replyText.toLowerCase();

      const naturalAbstention =
        mode === 'live' &&
        Boolean(tc.liveAllowNaturalAbstention) &&
        turn.status === 'COMPLETED' &&
        /\b(?:could(?:n't|\s+not)\s+find|cannot\s+find|can't\s+find|no\s+(?:relevant\s+|specific\s+)?(?:information|mention|results?|details)|don't\s+have\s+(?:enough\s+|any\s+|specific\s+)?(?:information|context|access))\b/i.test(
          replyText,
        );

      const routeMatch = actualRoute === tc.expectedRoute;
      const sourceMatch = actualSearchSource === tc.expectedSearchSource;
      const statusMatch = turn.status === tc.expectedStatus || naturalAbstention;

      const missingExpected = naturalAbstention
        ? []
        : tc.mustInclude.filter((needle) => !replyLower.includes(needle.toLowerCase()));
      const forbiddenFound = tc.mustNotInclude.filter((needle) =>
        replyLower.includes(needle.toLowerCase()),
      );
      const groundednessPass = missingExpected.length === 0 && forbiddenFound.length === 0;
      const passed = routeMatch && sourceMatch && statusMatch && groundednessPass;

      results.push({
        id: tc.id,
        category: tc.category,
        description: tc.description,
        question: tc.question,
        expectedRoute: tc.expectedRoute,
        actualRoute,
        routeMatch,
        expectedSearchSource: tc.expectedSearchSource,
        actualSearchSource,
        sourceMatch,
        expectedStatus: tc.expectedStatus,
        actualStatus: turn.status,
        statusMatch,
        groundednessPass,
        missingExpected,
        forbiddenFound,
        passed,
        reply: turn.bot_reply_raw,
        latencyMs,
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }

  const categories: EvalCategory[] = [
    'group_context',
    'web_browsing',
    'hybrid',
    'unanswerable_abstention',
    'refusal_or_clarify',
  ];
  const byCategory: EvalCategorySummary[] = categories.map((category) => {
    const sub = results.filter((r) => r.category === category);
    const passed = sub.filter((r) => r.passed).length;
    return {
      category,
      total: sub.length,
      passed,
      passRate: sub.length ? Math.round((passed / sub.length) * 1000) / 10 : 100,
    };
  });

  const passedCases = results.filter((r) => r.passed).length;
  const totalCases = results.length;
  const avgLatencyMs = totalCases
    ? Math.round((results.reduce((s, r) => s + r.latencyMs, 0) / totalCases) * 10) / 10
    : 0;

  return {
    mode,
    totalCases,
    passedCases,
    failedCases: totalCases - passedCases,
    passRate: totalCases ? Math.round((passedCases / totalCases) * 1000) / 10 : 100,
    avgLatencyMs,
    byCategory,
    results,
  };
}

export function formatEvalReport(report: EvalSummaryReport): string {
  const lines: string[] = [];
  lines.push('========================================================================================');
  lines.push(
    `  WHATSAPP GROUP AGENT — ANTI-HALLUCINATION EVALUATION HARNESS (mode: ${report.mode.toUpperCase()})`,
  );
  lines.push('========================================================================================');
  lines.push(
    `  Total Cases: ${report.totalCases} | Passed: ${report.passedCases} | Failed: ${report.failedCases} | Pass Rate: ${report.passRate}% | Avg Latency: ${report.avgLatencyMs}ms`,
  );
  lines.push('----------------------------------------------------------------------------------------');
  lines.push('  Category Breakdown:');
  for (const cat of report.byCategory) {
    lines.push(
      `    - ${cat.category.padEnd(25)} ${String(cat.passed).padStart(2)}/${String(cat.total).padEnd(2)} (${cat.passRate}%)`,
    );
  }
  lines.push('----------------------------------------------------------------------------------------');
  lines.push(
    `  ${'ID'.padEnd(34)} ${'Category'.padEnd(24)} ${'Route'.padEnd(7)} ${'Source'.padEnd(7)} ${'Status'.padEnd(7)} ${'Ground'.padEnd(7)} Result`,
  );
  lines.push('----------------------------------------------------------------------------------------');

  for (const r of report.results) {
    const mark = (ok: boolean) => (ok ? 'OK' : 'FAIL');
    lines.push(
      `  ${r.id.padEnd(34)} ${r.category.padEnd(24)} ${mark(r.routeMatch).padEnd(7)} ${mark(r.sourceMatch).padEnd(7)} ${mark(r.statusMatch).padEnd(7)} ${mark(r.groundednessPass).padEnd(7)} ${r.passed ? 'PASS' : 'FAIL'}`,
    );
    if (!r.passed) {
      lines.push(
        `    -> route=${r.actualRoute} (exp ${r.expectedRoute}), source=${r.actualSearchSource} (exp ${r.expectedSearchSource}), status=${r.actualStatus} (exp ${r.expectedStatus})`,
      );
      if (r.missingExpected.length) {
        lines.push(`    -> missing expected: ${JSON.stringify(r.missingExpected)}`);
      }
      if (r.forbiddenFound.length) {
        lines.push(`    -> forbidden found:  ${JSON.stringify(r.forbiddenFound)}`);
      }
      lines.push(`    -> reply: ${JSON.stringify(r.reply)}`);
    }
  }
  lines.push('========================================================================================');
  return lines.join('\n');
}
