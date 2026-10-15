import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Browsers,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeWASocket,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { AppConfig } from '../config/env.schema.js';
import { MessagesRepository } from '../messages/messages.repository.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { extractGroupMessage } from './message-extractor.js';
import { ConnectionState, GroupInfo, WhatsappStatus } from './whatsapp.types.js';

const LOGGED_OUT = 401;

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly baileysLogger: pino.Logger;

  private sock: WASocket | null = null;
  private state: ConnectionState = 'disconnected';
  private qr: string | null = null;
  private botJid: string | null = null;
  private botLid: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private nextReconnectAt: number | null = null;
  private lastDisconnectCode: number | null = null;
  /** True when the user asked to stop; prevents automatic reconnects. */
  private manualStop = false;
  /** Serializes socket creation so two sockets never run for the same session. */
  private starting: Promise<void> | null = null;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly messages: MessagesRepository,
  ) {
    this.baileysLogger = pino({ level: this.config.get('app', { infer: true }).logLevel });
  }

  async onModuleInit(): Promise<void> {
    if (this.cfg.autoConnectOnBoot) {
      this.logger.log('autoConnectOnBoot is enabled, connecting...');
      await this.connect();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.manualStop = true;
    this.teardownSocket();
  }

  private get cfg() {
    return this.config.get('whatsapp', { infer: true });
  }

  // ---------------------------------------------------------------- public API

  async connect(): Promise<WhatsappStatus> {
    if (this.sock || this.starting) {
      return this.status(); // already connecting / connected: idempotent
    }
    this.manualStop = false;
    this.reconnectAttempts = 0;
    try {
      await this.startSocket();
    } catch (e) {
      this.state = 'disconnected';
      throw e;
    }
    return this.status();
  }

  /** Closes the socket but keeps the session credentials on disk. */
  disconnect(): WhatsappStatus {
    this.manualStop = true;
    this.teardownSocket();
    this.logger.log('Disconnected (credentials kept)');
    return this.status();
  }

  /** Logs the linked device out and wipes the stored session; the next connect needs a new QR. */
  async logout(): Promise<WhatsappStatus> {
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
    await rm(resolve(this.cfg.authDir), { recursive: true, force: true });
    this.logger.log('Logged out and session wiped');
    return this.status();
  }

  status(): WhatsappStatus {
    return {
      state: this.state,
      botJid: this.botJid,
      botLid: this.botLid,
      botName: this.cfg.botName,
      reconnectAttempts: this.reconnectAttempts,
      nextReconnectAt: this.nextReconnectAt,
      hasQr: this.qr !== null,
      lastDisconnectCode: this.lastDisconnectCode,
    };
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

  async sendMessage(dto: SendMessageDto): Promise<{ id: string | null; jid: string }> {
    const sock = this.requireSocket();

    let quoted: WAMessage | undefined;
    if (dto.quotedMessageId) {
      const stored = this.messages.findById(dto.jid, dto.quotedMessageId);
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

    const sent = await sock.sendMessage(dto.jid, { text: dto.text }, quoted ? { quoted } : undefined);
    if (sent) this.ingest(sent);
    return { id: sent?.key?.id ?? null, jid: dto.jid };
  }

  // ------------------------------------------------------------------ internals

  private requireSocket(): WASocket {
    if (!this.sock || this.state !== 'connected') {
      throw new ConflictException(`WhatsApp is not connected (state: ${this.state})`);
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
    this.state = 'connecting';
    this.qr = null;

    const { state, saveCreds } = await useMultiFileAuthState(resolve(this.cfg.authDir));

    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch (e) {
      this.logger.warn(`Could not fetch latest WA version, using library default: ${(e as Error).message}`);
    }

    // A disconnect() may have been requested while we were loading.
    if (this.manualStop) {
      this.state = 'disconnected';
      return;
    }

    const sock = makeWASocket({
      auth: state,
      version,
      logger: this.baileysLogger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
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
        this.state = 'qr_pending';
        this.logger.log('QR code ready: scan it in WhatsApp > Linked devices (or GET /api/whatsapp/qr)');
        if (this.cfg.printQrInTerminal) qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === 'open') {
        this.state = 'connected';
        this.qr = null;
        this.reconnectAttempts = 0;
        this.nextReconnectAt = null;
        this.lastDisconnectCode = null;
        this.botJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
        this.botLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;
        this.logger.log(`Connected as ${this.botJid}`);
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as any)?.output?.statusCode as number | undefined;
        this.handleClose(code ?? null, lastDisconnect?.error?.message);
      }
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      if (!isCurrent()) return;
      for (const m of messages) this.ingest(m);
    });
  }

  private ingest(msg: WAMessage): void {
    try {
      const stored = extractGroupMessage(msg, this.botJid);
      if (stored) this.messages.insert(stored);
    } catch (e) {
      this.logger.error(`Failed to ingest message: ${(e as Error).message}`);
    }
  }

  private handleClose(code: number | null, reason?: string): void {
    this.sock = null;
    this.qr = null;
    this.lastDisconnectCode = code;
    this.logger.warn(`Connection closed (code ${code ?? 'n/a'}${reason ? `: ${reason}` : ''})`);

    if (this.manualStop) {
      this.state = 'disconnected';
      return;
    }

    if (code === LOGGED_OUT) {
      // Session was revoked from the phone: credentials are useless, require a fresh QR.
      this.state = 'disconnected';
      this.botJid = this.botLid = null;
      this.logger.warn('Logged out from the phone. Wiping session; call POST /connect to link again.');
      void rm(resolve(this.cfg.authDir), { recursive: true, force: true });
      return;
    }

    this.scheduleReconnect();
  }

  /** Exponential backoff with jitter. Never throws and never kills the process (NFR-4). */
  private scheduleReconnect(): void {
    const { baseDelayMs, maxDelayMs } = this.cfg.reconnect;
    const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** this.reconnectAttempts);
    const delay = Math.round(exp / 2 + Math.random() * (exp / 2));
    this.reconnectAttempts += 1;
    this.state = 'connecting';
    this.nextReconnectAt = Date.now() + delay;
    this.logger.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.clearReconnectTimer();
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
    this.state = 'disconnected';
    this.nextReconnectAt = null;
    if (sock) {
      try {
        sock.end(undefined);
      } catch (e) {
        this.logger.debug(`Error while closing socket: ${(e as Error).message}`);
      }
    }
  }
}
