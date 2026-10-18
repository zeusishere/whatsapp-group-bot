import { jest } from '@jest/globals';
import type { WAMessage } from '@whiskeysockets/baileys';
import Database from 'better-sqlite3';
import pino from 'pino';
import { configService, testConfig } from '../chatbot/testing/harness.js';
import { SCHEMA_SQL } from '../database/schema.sql.js';
import { MessagesRepository, StoredMessage } from '../messages/messages.repository.js';
import { SessionsRepository } from '../sessions/sessions.repository.js';

type Listener = (payload: any) => void;

const socketCalls: any[] = [];
let listeners: Record<string, Listener[]> = {};
let mockGroupParticipants: any[] = [];

jest.unstable_mockModule('@whiskeysockets/baileys', () => ({
  Browsers: { ubuntu: (name: string) => ['Ubuntu', name, '20.0'] },
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] as [number, number, number] }),
  jidNormalizedUser: (jid: string) => {
    const [user, domain] = jid.split('@');
    return `${user?.split(':')[0] ?? ''}@${domain ?? ''}`;
  },
  initAuthCreds: () => ({
    noiseKey: { private: Buffer.from([1]), public: Buffer.from([2]) },
    pairingEphemeralKeyPair: { private: Buffer.from([1]), public: Buffer.from([2]) },
    signedIdentityKey: { private: Buffer.from([1]), public: Buffer.from([2]) },
    signedPreKey: {
      keyPair: { private: Buffer.from([1]), public: Buffer.from([2]) },
      signature: Buffer.from([3]),
      keyId: 1,
    },
    registrationId: 1,
    advSecretKey: 'secret',
    processedHistoryMessages: [],
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },
    registered: false,
  }),
  BufferJSON: {
    replacer: (_k: string, v: unknown) => v,
    reviver: (_k: string, v: unknown) => v,
  },
  proto: {
    Message: {
      AppStateSyncKeyData: {
        fromObject: (v: unknown) => v,
      },
    },
  },
  makeWASocket: (opts: any) => {
    socketCalls.push(opts);
    listeners = {};
    return {
      user: { id: '15550001111:1@s.whatsapp.net', lid: '999888777:1@lid' },
      ev: {
        on: (event: string, fn: Listener) => {
          listeners[event] = listeners[event] ?? [];
          listeners[event].push(fn);
        },
      },
      groupMetadata: async () => ({
        id: GROUP,
        subject: 'Test Group',
        participants: mockGroupParticipants,
      }),
      end: () => undefined,
    };
  },
}));

const { SessionRuntime } = await import('./session-runtime.js');

const GROUP = '120363000000000000@g.us';
const BOT_JID = '15550001111@s.whatsapp.net';
const BOT_LID = '999888777@lid';

function makeMentionMessage(id: string, text: string, timestampSec = 1_700_000_000): WAMessage {
  return {
    key: {
      remoteJid: GROUP,
      id,
      fromMe: false,
      participant: '15552223333@s.whatsapp.net',
    },
    pushName: 'Alice',
    messageTimestamp: timestampSec,
    message: {
      extendedTextMessage: {
        text,
        contextInfo: {
          mentionedJid: [BOT_LID],
        },
      },
    },
  } as unknown as WAMessage;
}

function emit(event: string, payload: unknown) {
  for (const fn of listeners[event] ?? []) {
    fn(payload);
  }
}

describe('SessionRuntime historical vs live ingestion', () => {
  beforeEach(() => {
    socketCalls.length = 0;
    listeners = {};
    mockGroupParticipants = [];
  });

  function setup() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    const now = Date.now();
    db.prepare(
      `INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('u1', 'a@b.c', 'x', 'admin', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO sessions (id, owner_id, status, desired_state, jid, lid, created_at, updated_at)
       VALUES ('s1', 'u1', 'disconnected', 'connected', ?, ?, ?, ?)`,
    ).run(BOT_JID, BOT_LID, now, now);

    const database = { connection: db, isOpen: true } as never;
    const cfg = testConfig();
    const sessions = new SessionsRepository(database);
    const messages = new MessagesRepository(database, configService(cfg));
    const mentions: StoredMessage[] = [];

    const runtime = new SessionRuntime(
      's1',
      { state: 'disconnected', jid: BOT_JID, lid: BOT_LID },
      {
        database,
        sessions,
        messages,
        baileysLogger: pino({ level: 'silent' }),
        reconnect: { baseDelayMs: 1000, maxDelayMs: 5000 },
        printQrInTerminal: false,
        onMention: (_sessionId, msg) => mentions.push(msg),
      },
    );

    return { runtime, messages, mentions };
  }

  it('enables syncFullHistory and stores history/append messages without triggering onMention', async () => {
    const { runtime, messages, mentions } = setup();
    await runtime.connect();

    expect(socketCalls).toHaveLength(1);
    expect(socketCalls[0].syncFullHistory).toBe(true);

    emit('messaging-history.set', {
      messages: [
        makeMentionMessage('hist-1', '@999888777 old question 1', 1_700_000_001),
        makeMentionMessage('hist-2', '@999888777 old question 2', 1_700_000_002),
      ],
    });

    emit('messages.upsert', {
      type: 'append',
      messages: [makeMentionMessage('append-1', '@999888777 synced question', 1_700_000_003)],
    });

    expect(messages.findById('s1', GROUP, 'hist-1')?.text).toBe('@999888777 old question 1');
    expect(messages.findById('s1', GROUP, 'hist-2')?.text).toBe('@999888777 old question 2');
    expect(messages.findById('s1', GROUP, 'append-1')?.text).toBe('@999888777 synced question');
    expect(mentions).toHaveLength(0);
  });

  it('triggers onMention for live notify messages that mention the bot', async () => {
    const { runtime, messages, mentions } = setup();
    await runtime.connect();

    emit('messages.upsert', {
      type: 'notify',
      messages: [makeMentionMessage('live-1', '@999888777 live question', 1_700_000_010)],
    });

    expect(messages.findById('s1', GROUP, 'live-1')?.text).toBe('@999888777 live question');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].id).toBe('live-1');
  });

  it('getGroupMembers returns only active groupMetadata participants while enriching names from stored messages', async () => {
    const { runtime, messages } = setup();
    await runtime.connect();
    emit('connection.update', { connection: 'open' });

    // Stored messages include an active member ("Alice") and a former member who left ("Old Bob")
    messages.insert('s1', {
      id: 'm-active',
      groupId: GROUP,
      senderId: '15552223333@s.whatsapp.net',
      senderName: 'Alice',
      text: 'Hello from Alice',
      timestamp: 1_700_000_000_000,
      isBot: false,
      quotedMessageId: null,
      quotedParticipant: null,
      mentionedJids: [],
    });
    messages.insert('s1', {
      id: 'm-left',
      groupId: GROUP,
      senderId: '15559990000@s.whatsapp.net',
      senderName: 'Old Bob (Left)',
      text: 'Message from before Bob left the group',
      timestamp: 1_700_000_001_000,
      isBot: false,
      quotedMessageId: null,
      quotedParticipant: null,
      mentionedJids: [],
    });

    mockGroupParticipants = [
      { id: '15552223333@s.whatsapp.net' }, // active, name enriched from messages ("Alice")
      { id: '15554445555@s.whatsapp.net', notify: 'Charlie' }, // active silent member
      { id: BOT_JID, lid: BOT_LID }, // bot itself (excluded)
    ];

    const activeMembers = await runtime.getGroupMembers(GROUP);
    expect(activeMembers).toEqual([
      { jid: '15552223333@s.whatsapp.net', handle: '15552223333', name: 'Alice' },
      { jid: '15554445555@s.whatsapp.net', handle: '15554445555', name: 'Charlie' },
    ]);
  });
});
