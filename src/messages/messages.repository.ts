import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/env.schema.js';
import { DatabaseService } from '../database/database.service.js';

export interface StoredMessage {
  id: string;
  groupId: string;
  senderId: string;
  senderName: string | null;
  text: string;
  timestamp: number;
  isBot: boolean;
  quotedMessageId: string | null;
  quotedParticipant: string | null;
  mentionedJids: string[];
}

export interface GroupSummary {
  groupId: string;
  messageCount: number;
  lastTimestamp: number;
}

interface MessageRow {
  id: string;
  group_id: string;
  sender_id: string;
  sender_name: string | null;
  text: string;
  timestamp: number;
  is_bot: number;
  quoted_message_id: string | null;
  quoted_participant: string | null;
  mentioned_jids: string;
}

function toMessage(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    groupId: r.group_id,
    senderId: r.sender_id,
    senderName: r.sender_name,
    text: r.text,
    timestamp: r.timestamp,
    isBot: r.is_bot === 1,
    quotedMessageId: r.quoted_message_id,
    quotedParticipant: r.quoted_participant,
    mentionedJids: JSON.parse(r.mentioned_jids) as string[],
  };
}

@Injectable()
export class MessagesRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Inserts a message (ignored if already stored) and trims the group to the retention cap. */
  insert(m: StoredMessage): boolean {
    const db = this.database.connection;
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO messages
           (id, group_id, sender_id, sender_name, text, timestamp, is_bot,
            quoted_message_id, quoted_participant, mentioned_jids)
         VALUES (@id, @groupId, @senderId, @senderName, @text, @timestamp, @isBot,
                 @quotedMessageId, @quotedParticipant, @mentionedJids)`,
      )
      .run({
        ...m,
        isBot: m.isBot ? 1 : 0,
        mentionedJids: JSON.stringify(m.mentionedJids),
      });
    if (res.changes > 0) this.trim(m.groupId);
    return res.changes > 0;
  }

  /** Keeps only the newest N messages for a group (NFR-3). */
  private trim(groupId: string): void {
    const max = this.config.get('database', { infer: true }).maxMessagesPerGroup;
    this.database.connection
      .prepare(
        `DELETE FROM messages
         WHERE group_id = ?
           AND rowid NOT IN (
             SELECT rowid FROM messages WHERE group_id = ?
             ORDER BY timestamp DESC, rowid DESC LIMIT ?
           )`,
      )
      .run(groupId, groupId, max);
  }

  /**
   * Lists messages, newest first. Optionally filtered by group and paginated with
   * `before` (exclusive upper bound on timestamp, epoch ms).
   */
  list(opts: { groupId?: string; limit: number; before?: number }): StoredMessage[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: opts.limit };
    if (opts.groupId) {
      where.push('group_id = @groupId');
      params.groupId = opts.groupId;
    }
    if (opts.before !== undefined) {
      where.push('timestamp < @before');
      params.before = opts.before;
    }
    const sql = `SELECT * FROM messages
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY timestamp DESC, rowid DESC LIMIT @limit`;
    const rows = this.database.connection.prepare(sql).all(params) as MessageRow[];
    return rows.map(toMessage);
  }

  findById(groupId: string, id: string): StoredMessage | null {
    const row = this.database.connection
      .prepare('SELECT * FROM messages WHERE group_id = ? AND id = ?')
      .get(groupId, id) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  listGroups(): GroupSummary[] {
    const rows = this.database.connection
      .prepare(
        `SELECT group_id AS groupId, COUNT(*) AS messageCount, MAX(timestamp) AS lastTimestamp
         FROM messages GROUP BY group_id ORDER BY lastTimestamp DESC`,
      )
      .all() as GroupSummary[];
    return rows;
  }
}
