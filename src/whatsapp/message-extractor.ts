import type { WAMessage } from '@whiskeysockets/baileys';
import type { StoredMessage } from '../messages/messages.repository.js';

type AnyMsg = Record<string, any>;

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
] as const;

/** Unwraps ephemeral / view-once / edited wrappers around the real message content. */
function unwrap(content: AnyMsg | null | undefined): AnyMsg | undefined {
  let cur = content ?? undefined;
  for (let i = 0; i < 5 && cur; i++) {
    const wrapper = WRAPPERS.find((w) => cur![w]?.message);
    if (!wrapper) break;
    cur = cur[wrapper].message;
  }
  return cur;
}

function toMillis(ts: unknown): number {
  if (ts === null || ts === undefined) return Date.now();
  // protobuf Long has toNumber(); otherwise number or numeric string.
  const n =
    typeof ts === 'object' && typeof (ts as any).toNumber === 'function'
      ? (ts as any).toNumber()
      : Number(ts);
  return Number.isFinite(n) && n > 0 ? n * 1000 : Date.now();
}

/**
 * Converts a Baileys message into our stored shape.
 * Returns null for non-group chats and for messages without text (media, protocol, reactions, ...).
 */
export function extractGroupMessage(msg: WAMessage, botJid: string | null): StoredMessage | null {
  const groupId = msg.key?.remoteJid;
  const id = msg.key?.id;
  if (!groupId || !id || !groupId.endsWith('@g.us')) return null;

  const content = unwrap(msg.message as AnyMsg | null | undefined);
  if (!content) return null;

  const text: string | undefined = content.conversation || content.extendedTextMessage?.text;
  if (!text) return null;

  const ctx: AnyMsg | undefined = content.extendedTextMessage?.contextInfo;
  const fromMe = !!msg.key.fromMe;
  const senderId = fromMe ? (botJid ?? 'me') : (msg.key.participant ?? '');
  if (!senderId) return null;

  return {
    id,
    groupId,
    senderId,
    senderName: msg.pushName ?? null,
    text,
    timestamp: toMillis(msg.messageTimestamp),
    isBot: fromMe,
    quotedMessageId: ctx?.stanzaId ?? null,
    quotedParticipant: ctx?.participant ?? null,
    mentionedJids: Array.isArray(ctx?.mentionedJid) ? [...ctx!.mentionedJid] : [],
  };
}
