import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppConfig } from '../config/env.schema.js';
import { SCHEMA_SQL } from './schema.sql.js';

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
    this.db.exec(SCHEMA_SQL);
    this.logger.log(`SQLite ready at ${file} (journal_mode=${this.db.pragma('journal_mode', { simple: true })})`);
  }

  onModuleDestroy(): void {
    if (this.db?.open) this.db.close();
  }

  get connection(): Database.Database {
    return this.db;
  }
}
