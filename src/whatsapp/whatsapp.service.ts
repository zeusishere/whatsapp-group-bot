import {
  ConflictException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pino from 'pino';
import { AuthUser } from '../auth/auth.types.js';
import { AppConfig } from '../config/env.schema.js';
import { DatabaseService } from '../database/database.service.js';
import { MessagesRepository, StoredMessage } from '../messages/messages.repository.js';
import { SessionRecord, SessionsRepository } from '../sessions/sessions.repository.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { RuntimeDeps, SessionRuntime } from './session-runtime.js';
import { ConnectResult, GroupInfo, SessionStatus } from './whatsapp.types.js';

/** How long `connect` waits for a QR / connection before answering with the current state. */
const CONNECT_WAIT_MS = 15_000;

/** Inbound group mention. Registered by ChatService; kept here so WhatsApp does not import chatbot. */
export type MentionHandler = (deviceSessionId: string, message: StoredMessage) => void;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Manages every linked WhatsApp device. Each device is a `SessionRuntime`; this class owns the
 * runtimes, enforces ownership, restores sessions on boot and keeps `last_seen_at` fresh.
 */
@Injectable()
export class WhatsappService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly deps: RuntimeDeps;
  private heartbeat: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private mentionHandler: MentionHandler | null = null;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly database: DatabaseService,
    private readonly sessions: SessionsRepository,
    private readonly messages: MessagesRepository,
  ) {
    const wa = this.cfg;
    this.deps = {
      database,
      sessions,
      messages,
      baileysLogger: pino({ level: this.config.get('app', { infer: true }).logLevel }),
      reconnect: wa.reconnect,
      printQrInTerminal: wa.printQrInTerminal,
      onMention: (deviceSessionId, message) => this.mentionHandler?.(deviceSessionId, message),
    };
  }

  private get cfg() {
    return this.config.get('whatsapp', { infer: true });
  }

  // ---------------------------------------------------------------- lifecycle

  onModuleInit(): void {
    this.heartbeat = setInterval(() => this.beat(), this.cfg.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  /** Runs after every module (including the database) is initialised. */
  onApplicationBootstrap(): void {
    const stale = this.sessions.resetStaleStatuses();
    if (stale) this.logger.log(`Reset ${stale} stale session status(es) left over from the last run`);

    if (!this.cfg.restoreOnBoot) {
      this.logger.log('restoreOnBoot is disabled; sessions stay stopped until connected via the API');
      return;
    }
    // Not awaited: the HTTP server should come up while sessions reconnect in the background.
    void this.restoreSessions().catch((e: Error) => this.logger.error(`Session restore failed: ${e.message}`));
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.beat();
    // desired_state is deliberately untouched, so these sessions come back on the next boot.
    for (const runtime of this.runtimes.values()) runtime.shutdown();
  }

  /** Re-opens every paired session that was meant to be connected, one at a time. */
  private async restoreSessions(): Promise<void> {
    const toRestore = this.sessions.listToRestore();
    if (!toRestore.length) return;
    this.logger.log(`Restoring ${toRestore.length} session(s) from the database`);

    for (const rec of toRestore) {
      if (this.shuttingDown) return;
      try {
        await this.runtimeFor(rec).connect();
      } catch (e) {
        this.logger.error(`Could not restore session ${rec.id}: ${(e as Error).message}`);
      }
      await sleep(this.cfg.restoreStaggerMs);
    }
  }

  /** Records that connected sessions are still alive. */
  private beat(): void {
    const alive = [...this.runtimes.values()].filter((r) => r.isConnected()).map((r) => r.id);
    this.sessions.touch(alive, Date.now());
  }

  // ---------------------------------------------------------------- public API

  create(user: AuthUser, label: string | null): SessionStatus {
    const max = this.cfg.maxSessionsPerUser;
    if (this.sessions.countByOwner(user.id) >= max) {
      throw new ConflictException(`Session limit reached (${max} per user)`);
    }
    return this.toStatus(this.sessions.create(user.id, label));
  }

  list(user: AuthUser): SessionStatus[] {
    return this.sessions.listFor(user).map((rec) => this.toStatus(rec));
  }

  status(user: AuthUser, id: string): SessionStatus {
    return this.toStatus(this.sessions.requireAccessible(id, user));
  }

  /**
   * Starts the session and marks it to be restored on boot. Waits (up to `CONNECT_WAIT_MS`) until
   * the session either shows a QR or connects, so a never-paired session returns its QR directly.
   */
  async connect(user: AuthUser, id: string): Promise<ConnectResult> {
    const rec = this.sessions.requireAccessible(id, user);
    this.sessions.update(id, { desiredState: 'connected' });
    const runtime = this.runtimeFor(rec);
    await runtime.connect();
    await runtime.waitUntilSettled(CONNECT_WAIT_MS);

    const status = this.status(user, id);
    if (!status.hasQr) return { ...status, qr: null, qrDataUrl: null };
    try {
      const { qr, dataUrl } = await runtime.getQr();
      return { ...status, qr, qrDataUrl: dataUrl };
    } catch {
      return { ...status, qr: null, qrDataUrl: null }; // QR vanished (e.g. just connected)
    }
  }

  /** Closes the socket, keeps credentials, and stops the session from being restored on boot. */
  disconnect(user: AuthUser, id: string): SessionStatus {
    const rec = this.sessions.requireAccessible(id, user);
    this.sessions.update(id, { desiredState: 'stopped' });
    this.runtimes.get(rec.id)?.disconnect();
    return this.status(user, id);
  }

  /** Unlinks the device and wipes its credentials; the next connect needs a new QR. */
  async logout(user: AuthUser, id: string): Promise<SessionStatus> {
    const rec = this.sessions.requireAccessible(id, user);
    this.sessions.update(id, { desiredState: 'stopped' });
    await this.runtimeFor(rec).logout();
    return this.status(user, id);
  }

  /** Logs the device out (best effort) and deletes the session with its credentials and messages. */
  async remove(user: AuthUser, id: string): Promise<{ deleted: true }> {
    const rec = this.sessions.requireAccessible(id, user);
    const runtime = this.runtimes.get(rec.id);
    if (runtime) {
      await runtime.logout();
      this.runtimes.delete(rec.id);
    }
    this.database.connection.transaction(() => {
      this.messages.deleteBySession(rec.id);
      this.sessions.delete(rec.id); // cascades to auth_creds
    })();
    this.logger.log(`Deleted session ${rec.id}`);
    return { deleted: true };
  }

  getQr(user: AuthUser, id: string) {
    const rec = this.sessions.requireAccessible(id, user);
    return this.runtimeFor(rec).getQr();
  }

  listGroups(user: AuthUser, id: string): Promise<GroupInfo[]> {
    return this.connectedRuntime(user, id).listGroups();
  }

  sendMessage(user: AuthUser, id: string, dto: SendMessageDto) {
    return this.connectedRuntime(user, id).sendMessage(dto);
  }

  /**
   * Registers the mention handler. ChatService is the only caller; a second registration
   * replaces the first so tests can swap it.
   */
  setMentionHandler(handler: MentionHandler | null): void {
    this.mentionHandler = handler;
  }

  /**
   * Sends as a device session without an HTTP user. Used by the mention pipeline after
   * ownership has already been established through the thread binding.
   */
  sendAsSession(sessionId: string, dto: SendMessageDto) {
    const rec = this.sessions.findById(sessionId);
    if (!rec) throw new ConflictException(`WhatsApp session ${sessionId} is gone`);
    const runtime = this.runtimes.get(rec.id);
    if (!runtime?.isConnected()) {
      throw new ConflictException(`Session is not connected (state: ${runtime?.snapshot().state ?? rec.status})`);
    }
    return runtime.sendMessage(dto);
  }

  // ------------------------------------------------------------------ internals

  private connectedRuntime(user: AuthUser, id: string): SessionRuntime {
    const rec = this.sessions.requireAccessible(id, user);
    const runtime = this.runtimes.get(rec.id);
    if (!runtime?.isConnected()) {
      throw new ConflictException(`Session is not connected (state: ${runtime?.snapshot().state ?? rec.status})`);
    }
    return runtime;
  }

  /** The one place runtimes are created, so there is never more than one per session. */
  private runtimeFor(rec: SessionRecord): SessionRuntime {
    let runtime = this.runtimes.get(rec.id);
    if (!runtime) {
      runtime = new SessionRuntime(
        rec.id,
        { state: rec.status, jid: rec.jid, lid: rec.lid },
        this.deps,
      );
      this.runtimes.set(rec.id, runtime);
    }
    return runtime;
  }

  /** Merges the persisted row with the live runtime (if any). */
  private toStatus(rec: SessionRecord): SessionStatus {
    const fresh = this.sessions.findById(rec.id) ?? rec;
    const live = this.runtimes.get(rec.id)?.snapshot();
    return {
      id: fresh.id,
      ownerId: fresh.ownerId,
      label: fresh.label,
      state: live?.state ?? fresh.status,
      desiredState: fresh.desiredState,
      botJid: live?.botJid ?? fresh.jid,
      botLid: live?.botLid ?? fresh.lid,
      reconnectAttempts: live?.reconnectAttempts ?? 0,
      nextReconnectAt: live?.nextReconnectAt ?? null,
      hasQr: live?.hasQr ?? false,
      lastDisconnectCode: fresh.lastDisconnectCode,
      lastConnectedAt: fresh.lastConnectedAt,
      lastSeenAt: fresh.lastSeenAt,
      createdAt: fresh.createdAt,
    };
  }
}
