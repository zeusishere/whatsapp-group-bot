import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../database/schema.sql';
import { SessionsRepository } from '../sessions/sessions.repository';
import { SqliteAuthStore } from './sqlite-auth-state';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  const now = Date.now();
  db.prepare(`INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('u1','a@b.c','x','admin',?)`).run(now);
  for (const id of ['s1', 's2']) {
    db.prepare(
      `INSERT INTO sessions (id, owner_id, status, desired_state, created_at, updated_at)
       VALUES (?, 'u1', 'disconnected', 'connected', ?, ?)`,
    ).run(id, now, now);
  }
  return db;
}

describe('SqliteAuthStore', () => {
  it('initialises fresh creds, then reloads the saved ones', async () => {
    const db = setup();
    const first = new SqliteAuthStore(db, 's1').load();
    expect(first.state.creds.registered).toBe(false);
    first.state.creds.me = { id: '1555@s.whatsapp.net', name: 'Bot' };
    await first.saveCreds();

    const second = new SqliteAuthStore(db, 's1').load();
    expect(second.state.creds.me?.id).toBe('1555@s.whatsapp.net');
    expect(Buffer.isBuffer(second.state.creds.noiseKey.private) || second.state.creds.noiseKey.private instanceof Uint8Array).toBe(true);
    expect(second.state.creds.noiseKey.private).toEqual(first.state.creds.noiseKey.private);
  });

  it('stores, reads and deletes signal keys per session', async () => {
    const db = setup();
    const a = new SqliteAuthStore(db, 's1').load().state;
    const b = new SqliteAuthStore(db, 's2').load().state;
    const key = { private: Buffer.from([1, 2, 3]), public: Buffer.from([4, 5, 6]) };

    await a.keys.set({ 'pre-key': { '1': key } });
    expect((await a.keys.get('pre-key', ['1']))['1']).toEqual(key);
    expect((await b.keys.get('pre-key', ['1']))['1']).toBeNull();

    await a.keys.set({ 'pre-key': { '1': null as never } });
    expect((await a.keys.get('pre-key', ['1']))['1']).toBeNull();
  });

  it('clear() wipes only that session', async () => {
    const db = setup();
    for (const id of ['s1', 's2']) {
      const { saveCreds } = new SqliteAuthStore(db, id).load();
      await saveCreds();
    }
    new SqliteAuthStore(db, 's1').clear();
    const count = (id: string) =>
      (db.prepare('SELECT COUNT(*) n FROM auth_creds WHERE session_id = ?').get(id) as { n: number }).n;
    expect(count('s1')).toBe(0);
    expect(count('s2')).toBe(1);
  });

  it('deleting the session cascades to its credentials', async () => {
    const db = setup();
    await new SqliteAuthStore(db, 's1').load().saveCreds();
    db.prepare(`DELETE FROM sessions WHERE id = 's1'`).run();
    expect((db.prepare('SELECT COUNT(*) n FROM auth_creds').get() as { n: number }).n).toBe(0);
  });

  it('listToRestore returns only wanted-connected sessions that are paired', async () => {
    const db = setup();
    const repo = new SessionsRepository({ connection: db, isOpen: true } as never);

    // s1 paired, s2 has creds but never paired
    const s1 = new SqliteAuthStore(db, 's1').load();
    s1.state.creds.me = { id: '1555@s.whatsapp.net' };
    await s1.saveCreds();
    await new SqliteAuthStore(db, 's2').load().saveCreds();

    expect(repo.listToRestore().map((s) => s.id)).toEqual(['s1']);

    repo.update('s1', { desiredState: 'stopped' });
    expect(repo.listToRestore()).toEqual([]);
  });

  it('resetStaleStatuses marks live-looking sessions disconnected', () => {
    const db = setup();
    const repo = new SessionsRepository({ connection: db, isOpen: true } as never);
    repo.update('s1', { status: 'connected' });
    repo.update('s2', { status: 'logged_out' });
    expect(repo.resetStaleStatuses()).toBe(1);
    expect(repo.findById('s1')?.status).toBe('disconnected');
    expect(repo.findById('s2')?.status).toBe('logged_out');
  });
});
