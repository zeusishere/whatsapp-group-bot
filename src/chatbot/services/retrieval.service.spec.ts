import { RetrievalService } from './retrieval.service';
import { HeuristicReranker } from './reranker';
import { EmbeddingService } from './embedding.service';
import { toFtsQuery } from './text-utils';
import { bagVector, configService, openTestDb, StubEmbeddings, testConfig } from '../testing/harness';
import { normalize, toBlob } from './vector-math';

function service(h = openTestDb()) {
  const embeddings = new EmbeddingService(h.database, new StubEmbeddings(), h.messages);
  const retrieval = new RetrievalService(h.database, h.messages, embeddings, new HeuristicReranker(), h.trace, configService());
  return { ...h, embeddings, retrieval };
}

describe('toFtsQuery', () => {
  it('quotes terms so FTS operators in user text cannot change the query', () => {
    expect(toFtsQuery(['foo', 'AND', 'bar"baz'])).toBe('"foo" OR "AND" OR "bar""baz"');
    expect(toFtsQuery([])).toBeNull();
  });
});

describe('RetrievalService', () => {
  it('finds a message by keyword (BM25) and marks weak hits BELOW_THRESHOLD', async () => {
    const h = openTestDb();
    const stub = new StubEmbeddings();
    stub.configured = false;
    const embeddings = new EmbeddingService(h.database, stub, h.messages);
    const retrieval = new RetrievalService(h.database, h.messages, embeddings, new HeuristicReranker(), h.trace, configService());
    h.insertMessage({ id: 'm1', text: 'We decided the launch date is next Tuesday' });
    h.insertMessage({ id: 'm2', text: 'lol ok' });

    const out = await retrieval.retrieve({
      device_session_id: h.deviceSessionId,
      group_id: h.groupId,
      raw_query: 'when is the launch date',
      rewritten_queries: ['launch date Tuesday'],
    });
    expect(out.search_strategy).toBe('BM25');
    expect(out.notes.some((n) => n.startsWith('EMBEDDINGS_DISABLED'))).toBe(true);
    expect(out.chunks.some((c) => c.chunk_id === 'm1')).toBe(true);
    const weak = out.chunks.find((c) => c.chunk_id === 'm2');
    if (weak) expect(weak.drop_reason).toBe('BELOW_THRESHOLD');
  });

  it('fuses BM25 and cosine when embeddings exist (HYBRID)', async () => {
    const h = service();
    h.insertMessage({ id: 'm1', text: 'The release ships on Friday after QA sign-off' });
    const vec = normalize(bagVector('The release ships on Friday after QA sign-off'));
    h.db
      .prepare(
        `INSERT INTO message_embeddings (session_id, group_id, message_id, model, dim, vector, created_at)
         VALUES (?, ?, 'm1', ?, ?, ?, ?)`,
      )
      .run(h.deviceSessionId, h.groupId, h.embeddings.model, vec.length, toBlob(vec), Date.now());

    const out = await h.retrieval.retrieve({
      device_session_id: h.deviceSessionId,
      group_id: h.groupId,
      raw_query: 'when does the release ship',
      rewritten_queries: [],
    });
    expect(out.search_strategy).toBe('HYBRID');
    expect(out.chunks[0]?.chunk_id).toBe('m1');
    expect(out.chunks[0]?.scores.cosine).not.toBeNull();
    expect(out.chunks[0]?.scores.bm25).not.toBeNull();
  });

  it('degrades to BM25 when the embedding API fails', async () => {
    const h = service();
    h.insertMessage({ id: 'm1', text: 'budget approved for the conference' });
    const stub = new StubEmbeddings();
    stub.fail = true;
    const embeddings = new EmbeddingService(h.database, stub, h.messages);
    const retrieval = new RetrievalService(h.database, h.messages, embeddings, new HeuristicReranker(), h.trace, configService());

    const out = await retrieval.retrieve({
      device_session_id: h.deviceSessionId,
      group_id: h.groupId,
      raw_query: 'conference budget',
      rewritten_queries: [],
    });
    expect(out.search_strategy).toBe('BM25');
    expect(out.notes.some((n) => n.startsWith('EMBEDDING_UNAVAILABLE'))).toBe(true);
    expect(out.chunks.some((c) => c.chunk_id === 'm1')).toBe(true);
  });

  it('trimming a message removes it from FTS and embeddings', () => {
    const cfg = testConfig({ database: { path: ':memory:', maxMessagesPerGroup: 2 } });
    const h = openTestDb(cfg);
    const messages = h.messages;
    const t0 = 1_000;
    messages.insert(h.deviceSessionId, {
      id: 'old',
      groupId: h.groupId,
      senderId: '1@s.whatsapp.net',
      senderName: 'A',
      text: 'ancient history about penguins',
      timestamp: t0,
      isBot: false,
      quotedMessageId: null,
      quotedParticipant: null,
      mentionedJids: [],
    });
    h.db
      .prepare(
        `INSERT INTO message_embeddings (session_id, group_id, message_id, model, dim, vector, created_at)
         VALUES (?, ?, 'old', 'stub', 1, ?, ?)`,
      )
      .run(h.deviceSessionId, h.groupId, Buffer.alloc(4), t0);

    messages.insert(h.deviceSessionId, {
      id: 'n1',
      groupId: h.groupId,
      senderId: '1@s.whatsapp.net',
      senderName: 'A',
      text: 'newer one',
      timestamp: t0 + 1,
      isBot: false,
      quotedMessageId: null,
      quotedParticipant: null,
      mentionedJids: [],
    });
    messages.insert(h.deviceSessionId, {
      id: 'n2',
      groupId: h.groupId,
      senderId: '1@s.whatsapp.net',
      senderName: 'A',
      text: 'newest one',
      timestamp: t0 + 2,
      isBot: false,
      quotedMessageId: null,
      quotedParticipant: null,
      mentionedJids: [],
    });

    expect(h.db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).toEqual({ n: 2 });
    expect(h.db.prepare("SELECT COUNT(*) n FROM messages_fts WHERE message_id = 'old'").get() as { n: number }).toEqual({ n: 0 });
    expect(h.db.prepare("SELECT COUNT(*) n FROM message_embeddings WHERE message_id = 'old'").get() as { n: number }).toEqual({ n: 0 });
  });

  it('marks a secret-bearing chunk POLICY_FILTERED', async () => {
    const h = service();
    h.insertMessage({ id: 'm1', text: `here is the key AIza${'Q'.repeat(35)} do not share` });
    const out = await h.retrieval.retrieve({
      device_session_id: h.deviceSessionId,
      group_id: h.groupId,
      raw_query: 'what is the key',
      rewritten_queries: ['key'],
    });
    const hit = out.chunks.find((c) => c.chunk_id === 'm1');
    expect(hit?.drop_reason).toBe('POLICY_FILTERED');
  });
});
