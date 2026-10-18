import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import {
  Browsers,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeWASocket,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import type pino from 'pino';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { DatabaseService } from '../database/database.service.js';
import {
  GroupMember,
  jidHandle,
  MessagesRepository,
  normalizeJid,
  StoredMessage,
} from '../messages/messages.repository.js';
import { SessionPatch, SessionsRepository } from '../sessions/sessions.repository.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { extractGroupMessage } from './message-extractor.js';
import { SqliteAuthStore } from './sqlite-auth-state.js';
import { ConnectionState, GroupInfo } from './whatsapp.types.js';

const LOGGED_OUT = 401;

export interface RuntimeDeps {
  database: DatabaseService;
  sessions: SessionsRepository;
  messages: MessagesRepository;
  baileysLogger: pino.Logger;
  reconnect: { baseDelayMs: number; maxDelayMs: number };
  printQrInTerminal: boolean;
  /**
   * Called after a newly stored inbound group message that @-mentions this device.
   * Wired by WhatsappService; ChatService registers the actual handler. Must not throw.
   */
  onMention?: (deviceSessionId: string, message: StoredMessage) => void;
}

/** Volatile, in-memory facts about a running session. */
export interface RuntimeSnapshot {
  state: ConnectionState;
  botJid: string | null;
  botLid: string | null;
  reconnectAttempts: number;
  nextReconnectAt: number | null;
  hasQr: boolean;
}

/**
 * One linked WhatsApp device: its Baileys socket, reconnect loop and QR.
 * Every state change is mirrored into the `sessions` table through `setState`.
 */
export class SessionRuntime {
  private readonly logger: Logger;
  private readonly store: SqliteAuthStore;

  private sock: WASocket | null = null;
  private state: ConnectionState;
  private qr: string | null = null;
  private botJid: string | null = null;
  private botLid: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private nextReconnectAt: number | null = null;
  /** True when we were asked to stop; prevents automatic reconnects. */
  private manualStop = false;
  /** Serializes socket creation so two sockets never run for the same session. */
  private starting: Promise<void> | null = null;
  /** Callbacks notified on every state change; used by `waitUntilSettled`. */
  private readonly settleWaiters = new Set<(state: ConnectionState) => void>();

  constructor(
    readonly id: string,
    initial: { state: ConnectionState; jid: string | null; lid: string | null },
    private readonly deps: RuntimeDeps,
  ) {
    this.logger = new Logger(`Session:${id.slice(0, 8)}`);
    this.store = new SqliteAuthStore(deps.database.connection, id);
    this.state = initial.state;
    this.botJid = initial.jid;
    this.botLid = initial.lid;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Opens the socket (idempotent). Emits a QR first if the session was never paired. */
  async connect(): Promise<void> {
    if (this.sock || this.starting) return;
    this.manualStop = false;
    this.reconnectAttempts = 0;
    try {
      await this.startSocket();
    } catch (e) {
      this.setState('disconnected');
      throw e;
    }
  }

  /** Closes the socket but keeps the stored credentials. */
  disconnect(): void {
    this.manualStop = true;
    this.teardownSocket();
    this.logger.log('Disconnected (credentials kept)');
  }

  /** Unlinks the device from WhatsApp and wipes its credentials; the next connect needs a new QR. */
  async logout(): Promise<void> {
    this.manualStop = true;
    const sock = this.sock;
    if (sock && this.state === 'connected') {
      try {
        await sock.logout();
      } catch (e) {
        this.logger.warn(`logout() failed, wiping local session anyway: ${(e as Error).message}`);
      }
    }
    this.teardownSocket();
    this.store.clear();
    this.botJid = this.botLid = null;
    this.setState('logged_out', { jid: null, lid: null });
    this.logger.log('Logged out and credentials wiped');
  }

  /** Stops the socket because the process is exiting. Desired state is left untouched so the session is restored on boot. */
  shutdown(): void {
    this.manualStop = true;
    this.teardownSocket();
  }

  // ----------------------------------------------------------------- queries

  isConnected(): boolean {
    return this.state === 'connected';
  }

  snapshot(): RuntimeSnapshot {
    return {
      state: this.state,
      botJid: this.botJid,
      botLid: this.botLid,
      reconnectAttempts: this.reconnectAttempts,
      nextReconnectAt: this.nextReconnectAt,
      hasQr: this.qr !== null,
    };
  }

  /**
   * Resolves once the session reaches a state that needs no further waiting
   * (QR ready, connected, disconnected or logged out), or after `timeoutMs`.
   * `connecting` is the only transient state, so it keeps waiting.
   */
  waitUntilSettled(timeoutMs: number): Promise<ConnectionState> {
    if (this.state !== 'connecting') return Promise.resolve(this.state);
    return new Promise((resolve) => {
      const done = (state: ConnectionState) => {
        clearTimeout(timer);
        this.settleWaiters.delete(listener);
        resolve(state);
      };
      const listener = (state: ConnectionState) => {
        if (state !== 'connecting') done(state);
      };
      const timer = setTimeout(() => done(this.state), timeoutMs);
      this.settleWaiters.add(listener);
    });
  }

  async getQr(): Promise<{ qr: string; dataUrl: string }> {
    if (!this.qr) {
      throw new NotFoundException('No QR code available (not in qr_pending state)');
    }
    const dataUrl = await QRCode.toDataURL(this.qr, { margin: 2, width: 320 });
    return { qr: this.qr, dataUrl };
  }

  async listGroups(): Promise<GroupInfo[]> {
    const sock = this.requireSocket();
    const groups = await sock.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({
      id: g.id,
      subject: g.subject,
      participants: g.participants.length,
      creation: g.creation ?? null,
    }));
  }

  async getGroupMembers(groupId: string): Promise<GroupMember[]> {
    const botJids = [this.botJid, this.botLid].filter((j): j is string => !!j);
    const known = this.deps.messages.listGroupMembers(this.id, groupId, botJids);
    if (!this.sock || this.state !== 'connected') return known;

    try {
      const meta = await this.sock.groupMetadata(groupId);
      const excluded = new Set(botJids.flatMap((j) => [normalizeJid(j), jidHandle(j)]));
      const knownByHandle = new Map<string, GroupMember>();
      for (const m of known) {
        knownByHandle.set(m.handle, m);
      }

      const activeByHandle = new Map<string, GroupMember>();
      for (const p of meta.participants ?? []) {
        const rawJid = p.id || p.lid || p.phoneNumber;
        if (!rawJid) continue;
        const jid = normalizeJid(rawJid);
        const handle = jidHandle(jid);
        if (!handle || excluded.has(jid) || excluded.has(handle)) continue;
        const pLid = p.lid ? jidHandle(p.lid) : null;
        const pPn = p.phoneNumber ? jidHandle(p.phoneNumber) : null;
        if ((pLid && excluded.has(pLid)) || (pPn && excluded.has(pPn))) continue;

        const knownMatch =
          knownByHandle.get(handle) ??
          (pLid ? knownByHandle.get(pLid) : undefined) ??
          (pPn ? knownByHandle.get(pPn) : undefined);
        const metaName =
          [p.name, p.notify, p.verifiedName]
            .find((n) => typeof n === 'string' && n.trim().length > 0)
            ?.trim() ?? null;
        const resolvedName = knownMatch?.name ?? metaName;
        const resolvedJid = knownMatch?.jid ?? jid;
        const resolvedHandle = knownMatch?.handle ?? handle;
        activeByHandle.set(resolvedHandle, {
          jid: resolvedJid,
          handle: resolvedHandle,
          name: resolvedName,
        });
      }
      return [...activeByHandle.values()];
    } catch {
      return known;
    }
  }

  async sendMessage(dto: SendMessageDto): Promise<{ id: string | null; jid: string }> {
    const sock = this.requireSocket();

    let quoted: WAMessage | undefined;
    if (dto.quotedMessageId) {
      const stored = this.deps.messages.findById(this.id, dto.jid, dto.quotedMessageId);
      if (!stored) {
        throw new NotFoundException(`Quoted message ${dto.quotedMessageId} not found in ${dto.jid}`);
      }
      quoted = {
        key: {
          remoteJid: dto.jid,
          id: stored.id,
          fromMe: stored.isBot,
          participant: stored.isBot ? undefined : stored.senderId,
        },
        message: { conversation: stored.text },
      };
    }

    const mentionSet = new Set<string>(dto.mentions ?? []);
    if (dto.jid.endsWith('@g.us') && /@\d{5,20}\b/.test(dto.text)) {
      const members = await this.getGroupMembers(dto.jid);
      const byHandle = new Map(members.map((m) => [m.handle, m.jid]));
      for (const match of dto.text.matchAll(/(?<![A-Za-z0-9._%+-])@(\d{5,20})\b/g)) {
        const jid = byHandle.get(match[1]);
        if (jid) mentionSet.add(jid);
      }
    }
    const mentions = [...mentionSet];

    const sent = await sock.sendMessage(
      dto.jid,
      { text: dto.text, ...(mentions.length ? { mentions } : {}) },
      quoted ? { quoted } : undefined,
    );
    if (sent) this.ingest(sent);
    return { id: sent?.key?.id ?? null, jid: dto.jid };
  }

  // ---------------------------------------------------------------- internals

  /** The single place state changes: updates memory and mirrors the change to the database. */
  private setState(state: ConnectionState, extra: SessionPatch = {}): void {
    this.state = state;
    try {
      this.deps.sessions.update(this.id, { status: state, ...extra });
    } catch (e) {
      this.logger.error(`Could not persist state "${state}": ${(e as Error).message}`);
    }
    for (const waiter of [...this.settleWaiters]) waiter(state);
  }

  private requireSocket(): WASocket {
    if (!this.sock || this.state !== 'connected') {
      throw new ConflictException(`WhatsApp session is not connected (state: ${this.state})`);
    }
    return this.sock;
  }

  private startSocket(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.doStartSocket().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStartSocket(): Promise<void> {
    this.clearReconnectTimer();
    this.setState('connecting');
    this.qr = null;

    const { state, saveCreds } = this.store.load();

    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch (e) {
      this.logger.warn(`Could not fetch latest WA version, using library default: ${(e as Error).message}`);
    }

    // A disconnect() may have been requested while we were loading.
    if (this.manualStop) {
      this.setState('disconnected');
      return;
    }

    const sock = makeWASocket({
      auth: state,
      version,
      logger: this.deps.baileysLogger.child({ sessionId: this.id }),
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: true,
    });
    this.sock = sock;

    // Events from a socket we've already replaced or torn down are ignored.
    const isCurrent = () => this.sock === sock;

    sock.ev.on('creds.update', () => {
      if (isCurrent()) void saveCreds();
    });

    sock.ev.on('connection.update', (update) => {
      if (!isCurrent()) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qr = qr;
        this.setState('qr_pending');
        this.logger.log('QR code ready: scan it in WhatsApp > Linked devices');
        if (this.deps.printQrInTerminal) qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === 'open') {
        this.qr = null;
        this.reconnectAttempts = 0;
        this.nextReconnectAt = null;
        this.botJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
        this.botLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;
        const now = Date.now();
        this.setState('connected', {
          jid: this.botJid,
          lid: this.botLid,
          lastDisconnectCode: null,
          lastConnectedAt: now,
          lastSeenAt: now,
        });
        this.logger.log(`Connected as ${this.botJid}`);
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as any)?.output?.statusCode as number | undefined;
        this.handleClose(code ?? null, lastDisconnect?.error?.message);
      }
    });

    sock.ev.on('messaging-history.set', ({ messages }) => {
      if (!isCurrent()) return;
      for (const m of messages) this.ingest(m, false);
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (!isCurrent()) return;
      const allowMentionReply = type === 'notify';
      for (const m of messages) this.ingest(m, allowMentionReply);
    });
  }

  private ingest(msg: WAMessage, allowMentionReply = false): void {
    try {
      const stored = extractGroupMessage(msg, this.botJid);
      if (!stored) return;
      this.deps.messages.insert(this.id, stored);
      // Bot-authored and historical/append messages never trigger a turn; live mentions of this device do.
      if (allowMentionReply && !stored.isBot && this.mentionsBot(stored)) {
        try {
          this.deps.onMention?.(this.id, stored);
        } catch (e) {
          this.logger.error(`Mention handler failed: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.logger.error(`Failed to ingest message: ${(e as Error).message}`);
    }
  }

  /** True when the message @-mentioned this device's JID or LID. */
  private mentionsBot(m: StoredMessage): boolean {
    const mine = [this.botJid, this.botLid].filter((j): j is string => !!j).map((j) => jidNormalizedUser(j));
    if (!mine.length) return false;
    return m.mentionedJids.some((j) => mine.includes(jidNormalizedUser(j)));
  }

  private handleClose(code: number | null, reason?: string): void {
    this.sock = null;
    this.qr = null;
    this.logger.warn(`Connection closed (code ${code ?? 'n/a'}${reason ? `: ${reason}` : ''})`);

    if (this.manualStop) {
      this.setState('disconnected', { lastDisconnectCode: code });
      return;
    }

    if (code === LOGGED_OUT) {
      // Session was revoked from the phone: credentials are useless, require a fresh QR.
      this.store.clear();
      this.botJid = this.botLid = null;
      this.setState('logged_out', {
        jid: null,
        lid: null,
        lastDisconnectCode: code,
        desiredState: 'stopped',
      });
      this.logger.warn('Logged out from the phone. Credentials wiped; connect again to link a new device.');
      return;
    }

    this.scheduleReconnect(code);
  }

  /** Exponential backoff with jitter. Never throws and never kills the process (NFR-4). */
  private scheduleReconnect(code: number | null = null): void {
    const { baseDelayMs, maxDelayMs } = this.deps.reconnect;
    const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** this.reconnectAttempts);
    const delay = Math.round(exp / 2 + Math.random() * (exp / 2));
    this.reconnectAttempts += 1;
    this.setState('connecting', code !== null ? { lastDisconnectCode: code } : {});
    this.logger.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.clearReconnectTimer();
    this.nextReconnectAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.nextReconnectAt = null;
      if (this.manualStop) return;
      this.startSocket().catch((e: Error) => {
        this.logger.error(`Reconnect failed: ${e.message}`);
        if (!this.manualStop) this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.nextReconnectAt = null;
  }

  private teardownSocket(): void {
    this.clearReconnectTimer();
    const sock = this.sock;
    this.sock = null; // makes in-flight event handlers ignore this socket
    this.qr = null;
    this.setState('disconnected');
    if (sock) {
      try {
        sock.end(undefined);
      } catch (e) {
        this.logger.debug(`Error while closing socket: ${(e as Error).message}`);
      }
    }
  }
}
