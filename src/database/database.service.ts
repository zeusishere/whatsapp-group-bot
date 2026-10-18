import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MIGRATE_DECISION_SPANS_WEB_SEARCH_SQL, TRACE_SCHEMA_SQL } from '../chatbot/models/trace.schema.js';
import { AppConfig } from '../config/env.schema.js';
import { MIGRATE_MESSAGES_SQL, SCHEMA_SQL } from './schema.sql.js';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private db!: Database.Database;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  onModuleInit(): void {
    const dbPath = this.config.get('database', { infer: true }).path;
    const file = dbPath === ':memory:' ? dbPath : resolve(dbPath);
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

    this.db = new Database(file);
    // WAL prevents lock contention between passive ingestion and reads (NFR-3).
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.db.exec(SCHEMA_SQL);
    this.db.exec(TRACE_SCHEMA_SQL);
    this.migrateDecisionSpans();
    this.ensureRetrievalIndexes();
    this.logger.log(`SQLite ready at ${file} (journal_mode=${this.db.pragma('journal_mode', { simple: true })})`);
  }

  onModuleDestroy(): void {
    if (this.db?.open) this.db.close();
  }

  get connection(): Database.Database {
    return this.db;
  }

  /** False once the connection has been closed (e.g. during shutdown). */
  get isOpen(): boolean {
    return !!this.db?.open;
  }

  /**
   * The full-text index is maintained by triggers, but databases that already held messages
   * before it existed (or whose rowids were renumbered by VACUUM) need a rebuild. Row counts
   * are a cheap drift detector.
   */
  private ensureRetrievalIndexes(): void {
    const count = (table: string) =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    if (count('messages') === count('messages_fts')) return;
    this.logger.log('Rebuilding messages_fts (out of sync with messages)');
    this.db.transaction(() => {
      this.db.exec('DELETE FROM messages_fts');
      this.db.exec(
        `INSERT INTO messages_fts (rowid, text, session_id, group_id, message_id)
         SELECT rowid, text, session_id, group_id, id FROM messages`,
      );
    })();
  }

  /** One-off upgrades of databases created by earlier versions. */
  private migrate(): void {
    const cols = this.db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
    if (cols.length > 0 && !cols.some((c) => c.name === 'session_id')) {
      this.logger.log('Migrating messages table to multi-session layout');
      this.db.transaction(() => this.db.exec(MIGRATE_MESSAGES_SQL))();
    }
  }

  /** Existing DBs were created with a CHECK that does not list WEB_SEARCH / WEB_FETCH. */
  private migrateDecisionSpans(): void {
    const row = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'decision_spans'`).get() as
      | { sql: string }
      | undefined;
    if (!row?.sql || (row.sql.includes("'WEB_SEARCH'") && row.sql.includes("'WEB_FETCH'"))) return;
    this.logger.log('Migrating decision_spans to allow WEB_SEARCH and WEB_FETCH');
    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.transaction(() => this.db.exec(MIGRATE_DECISION_SPANS_WEB_SEARCH_SQL))();
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }
}
