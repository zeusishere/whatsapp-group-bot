import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { AuthUser } from '../../auth/auth.types.js';
import { AppConfig } from '../../config/env.schema.js';
import { SessionsRepository } from '../../sessions/sessions.repository.js';
import { StoredMessage } from '../../messages/messages.repository.js';
import { SendMessageDto } from '../../whatsapp/dto/send-message.dto.js';
import { WhatsappService } from '../../whatsapp/whatsapp.service.js';
import { LlmClient } from '../llm/llm-client.js';
import { ChatThread, ConversationTurn, TurnStatus } from '../models/types.js';
import { TraceRepository } from '../tracing/trace.repository.js';
import { TraceService } from '../tracing/trace.service.js';
import { ChatPipelineService } from './chat-pipeline.service.js';

export interface ChatRequest {
  /** Existing conversation thread (the blueprint's session_id). */
  sessionId?: string;
  /** WhatsApp device session to bind a new thread to. */
  deviceSessionId?: string;
  /** Group JID the thread searches (`...@g.us`). Required with `deviceSessionId`. */
  groupId?: string;
  message: string;
}

export interface ChatResult {
  turnId: string;
  sessionId: string;
  status: TurnStatus;
  reply: string | null;
  /** True when this request created the turn; false on an idempotent replay. */
  created: boolean;
  /** True when the existing turn is still running (HTTP 202). */
  inProgress: boolean;
  botMessageId: string | null;
}

/**
 * Public entry point for a turn: REST and WhatsApp mentions.
 *
 * Idempotency (edge case 4) is enforced by a unique index on `idempotency_key`, not by an
 * in-memory check, so a double-submit (or a redelivered WhatsApp event) cannot create a second
 * graph. Turns on the same thread are then serialized with a per-thread mutex so history and
 * retrieval stay consistent even when two different messages arrive at once.
 */
@Injectable()
export class ChatService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(ChatService.name);
  private readonly bot: AppConfig['bot'];
  /** Tail of the per-thread queue. Awaiting it waits for every earlier turn of that thread. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly llm: LlmClient,
    private readonly trace: TraceService,
    private readonly repo: TraceRepository,
    private readonly pipeline: ChatPipelineService,
    private readonly sessions: SessionsRepository,
    private readonly whatsapp: WhatsappService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.bot = config.get('bot', { infer: true });
  }

  onModuleInit(): void {
    if (!this.llm.configured) {
      this.logger.warn('llm.apiKey is not set; POST /api/chat and mention replies are disabled');
      return;
    }
    this.whatsapp.setMentionHandler((deviceSessionId, message) => {
      void this.handleMention(deviceSessionId, message);
    });
  }

  onApplicationBootstrap(): void {
    const reaped = this.repo.reapStaleTurns();
    if (reaped) this.logger.log(`Reaped ${reaped} in-progress turn(s) left over from the last process`);
  }

  get configured(): boolean {
    return this.llm.configured;
  }

  /** REST entry. Throws 503 when the model is not configured. */
  async handleRest(user: AuthUser, req: ChatRequest, idempotencyKey: string | undefined): Promise<ChatResult> {
    this.requireConfigured();
    const thread = this.resolveThread(user, req);
    const key = idempotencyKey?.trim()
      ? `rest:${user.id}:${idempotencyKey.trim()}`
      : `rest:${user.id}:${hashKey(`${thread.session_id}\0${req.message}`)}`;
    return this.runTurn(thread, {
      question: req.message,
      idempotencyKey: key,
      inboundExternalId: null,
      quotedMessageId: null,
    });
  }

  /**
   * WhatsApp mention entry. Errors are swallowed: a failed turn must never take down ingestion.
   * The reply is sent as a quote of the user's message when the turn produced one.
   */
  async handleMention(deviceSessionId: string, message: StoredMessage): Promise<void> {
    if (!this.llm.configured) return;
    try {
      const device = this.sessions.findById(deviceSessionId);
      if (!device) return;
      const thread = this.repo.getOrCreateBoundThread(device.ownerId, deviceSessionId, message.groupId);
      const result = await this.runTurn(thread, {
        question: message.text,
        idempotencyKey: `wa:${deviceSessionId}:${message.id}`,
        inboundExternalId: message.id,
        quotedMessageId: message.quotedMessageId,
      });
      if (!result.reply || result.inProgress || result.status === 'FAILED') return;

      const dto: SendMessageDto = { jid: message.groupId, text: result.reply, quotedMessageId: message.id };
      const sent = await this.whatsapp.sendAsSession(deviceSessionId, dto);
      if (sent.id && result.botMessageId) this.repo.setMessageExternalId(result.botMessageId, sent.id);
    } catch (e) {
      this.logger.error(`Mention turn failed for ${deviceSessionId}/${message.id}: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- internals

  private requireConfigured(): void {
    if (!this.llm.configured) {
      throw new ServiceUnavailableException('Chat is disabled: set llm.apiKey in env.json');
    }
  }

  private resolveThread(user: AuthUser, req: ChatRequest): ChatThread {
    if (req.sessionId) {
      const thread = this.repo.getThread(req.sessionId);
      if (!thread || (user.role !== 'admin' && thread.owner_id !== user.id)) {
        throw new NotFoundException(`Thread ${req.sessionId} not found`);
      }
      return thread;
    }
    if (req.deviceSessionId && req.groupId) {
      if (!req.groupId.endsWith('@g.us')) {
        throw new BadRequestException('groupId must be a WhatsApp group JID (...@g.us)');
      }
      this.sessions.requireAccessible(req.deviceSessionId, user);
      return this.repo.getOrCreateBoundThread(user.id, req.deviceSessionId, req.groupId);
    }
    throw new BadRequestException('Provide sessionId, or both deviceSessionId and groupId');
  }

  /**
   * Claims the idempotency key first (so a duplicate returns immediately, including 202 while
   * the original is still running), then serializes new turns of the same thread.
   */
  private async runTurn(
    thread: ChatThread,
    input: {
      question: string;
      idempotencyKey: string;
      inboundExternalId: string | null;
      quotedMessageId: string | null;
    },
  ): Promise<ChatResult> {
    const claim = this.trace.claim({
      session_id: thread.session_id,
      idempotency_key: input.idempotencyKey,
      user_input_raw: input.question,
      user_external_id: input.inboundExternalId,
    });

    if (!claim.created) return toResult(claim.turn, false);

    const turn = await this.withThreadLock(thread.session_id, () =>
      claim.collector.run(async (collector) => {
        const history = this.repo.recentMessages(thread.session_id, claim.turn.turn_id, this.bot.recentHistoryTurns);
        await this.pipeline.execute(collector, {
          thread,
          question: input.question,
          history,
          inbound_external_id: input.inboundExternalId,
          quoted_message_id: input.quotedMessageId,
        });
      }),
    );
    return toResult(turn, true);
  }

  /** Queues work behind every earlier turn of the same thread. */
  private async withThreadLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.locks.set(sessionId, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(sessionId) === next) this.locks.delete(sessionId);
    }
  }
}

function toResult(turn: ConversationTurn, created: boolean): ChatResult {
  return {
    turnId: turn.turn_id,
    sessionId: turn.session_id,
    status: turn.status,
    reply: turn.bot_reply_raw,
    created,
    inProgress: turn.status === 'IN_PROGRESS',
    botMessageId: turn.bot_message_id,
  };
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
