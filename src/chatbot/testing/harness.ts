import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { AuthUser } from '../../auth/auth.types.js';
import { AppConfig, DEFAULT_CONFIG } from '../../config/env.schema.js';
import { SCHEMA_SQL } from '../../database/schema.sql.js';
import { DatabaseService } from '../../database/database.service.js';
import { MessagesRepository, StoredMessage } from '../../messages/messages.repository.js';
import { TRACE_SCHEMA_SQL } from '../models/trace.schema.js';
import { ChatThread } from '../models/types.js';
import { EmbeddingClient, LlmClient, LlmRequest, LlmResponse } from '../llm/llm-client.js';
import { TraceRepository } from '../tracing/trace.repository.js';
import { TraceService } from '../tracing/trace.service.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    auth: { ...DEFAULT_CONFIG.auth, jwtSecret: 'x'.repeat(32), ...overrides.auth },
    llm: { ...DEFAULT_CONFIG.llm, apiKey: 'test-key', ...overrides.llm },
    bot: { ...DEFAULT_CONFIG.bot, ...overrides.bot },
    tracing: { ...DEFAULT_CONFIG.tracing, ...overrides.tracing },
    database: { ...DEFAULT_CONFIG.database, path: ':memory:', ...overrides.database },
  };
}

export function configService(cfg: AppConfig = testConfig()): ConfigService<AppConfig, true> {
  return {
    get: (key: keyof AppConfig) => cfg[key],
  } as ConfigService<AppConfig, true>;
}

export interface TestDb {
  db: Database.Database;
  database: DatabaseService;
  repo: TraceRepository;
  messages: MessagesRepository;
  trace: TraceService;
  user: AuthUser;
  thread: ChatThread;
  deviceSessionId: string;
  groupId: string;
  insertMessage: (m: Partial<StoredMessage> & { id: string; text: string }) => void;
}

/** In-memory SQLite with both schemas, one admin user, one device session and one bound thread. */
export function openTestDb(cfg: AppConfig = testConfig()): TestDb {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.exec(TRACE_SCHEMA_SQL);

  const now = Date.now();
  const userId = '11111111-1111-4111-8111-111111111111';
  const deviceSessionId = '22222222-2222-4222-8222-222222222222';
  const groupId = '120363000000000000@g.us';
  db.prepare(`INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, 'a@b.c', 'x', 'admin', ?)`).run(userId, now);
  db.prepare(
    `INSERT INTO sessions (id, owner_id, status, desired_state, created_at, updated_at) VALUES (?, ?, 'disconnected', 'stopped', ?, ?)`,
  ).run(deviceSessionId, userId, now, now);

  const database = { connection: db, isOpen: true } as DatabaseService;
  const repo = new TraceRepository(database);
  const messages = new MessagesRepository(database, configService(cfg));
  const trace = new TraceService(repo, configService(cfg));
  const thread = repo.getOrCreateBoundThread(userId, deviceSessionId, groupId);
  const user: AuthUser = { id: userId, email: 'a@b.c', role: 'admin' };

  const insertMessage = (m: Partial<StoredMessage> & { id: string; text: string }) => {
    messages.insert(deviceSessionId, {
      id: m.id,
      groupId,
      senderId: m.senderId ?? '111@s.whatsapp.net',
      senderName: m.senderName ?? 'Alice',
      text: m.text,
      timestamp: m.timestamp ?? Date.now(),
      isBot: m.isBot ?? false,
      quotedMessageId: m.quotedMessageId ?? null,
      quotedParticipant: m.quotedParticipant ?? null,
      mentionedJids: m.mentionedJids ?? [],
    });
  };

  return { db, database, repo, messages, trace, user, thread, deviceSessionId, groupId, insertMessage };
}

export class StubLlm extends LlmClient {
  readonly model_name = 'stub-model';
  configured = true;
  calls: LlmRequest[] = [];
  handler: (req: LlmRequest) => Promise<LlmResponse> | LlmResponse = () => ({
    text: '{"queries":["fallback"]}',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    model: this.model_name,
    finish_reason: 'STOP',
  });

  async generate(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    return this.handler(request);
  }
}

export class StubEmbeddings extends EmbeddingClient {
  readonly model_name = 'stub-embed';
  configured = true;
  fail = false;
  /** Deterministic bag-of-words vectors so tests can control cosine similarity. */
  async embed(texts: string[]): Promise<number[][]> {
    if (this.fail) throw new Error('embedding down');
    return texts.map((t) => bagVector(t));
  }
}

/** 8-d hashed bag-of-words, stable across runs. */
export function bagVector(text: string): number[] {
  const v = new Array(8).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 8] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export function jsonReply(obj: unknown): LlmResponse {
  return {
    text: JSON.stringify(obj),
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    model: 'stub-model',
    finish_reason: 'STOP',
  };
}

export function textReply(text: string): LlmResponse {
  return {
    text,
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    model: 'stub-model',
    finish_reason: 'STOP',
  };
}
