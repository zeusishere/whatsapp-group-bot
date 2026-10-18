import { createHash } from 'node:crypto';
import { StoredMessage } from './messages.repository.js';

export interface StructuredImportMessage {
  id?: string;
  senderId?: string;
  senderName?: string | null;
  text: string;
  timestamp: number;
}

const DIRECTIONAL_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Matches both Android (`12/05/2024, 10:30 pm - Sender: text`) and iOS/Desktop
 * (`[12/05/24, 10:30:15 PM] Sender: text`) WhatsApp export header lines.
 */
const HEADER_RE =
  /^\[?(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:[\s\u202f\u00a0]*[AaPp][Mm])?)\]?(?:\s*-\s*|\s+)(.*)$/;

const OMITTED_MEDIA_RE =
  /^(?:<(?:media|image|video|audio|document|sticker|gif)\s+omitted>|(?:image|video|audio|document|sticker|gif|contact card)\s+omitted|null)$/i;

const SYSTEM_BODY_RE =
  /^(?:messages and calls are end-to-end encrypted|this message was deleted|you deleted this message|waiting for this message)/i;

function stripFormattingMarks(input: string): string {
  return input.replace(DIRECTIONAL_MARKS, '');
}

/**
 * Resolves a sender string from a WhatsApp `.txt` export into `{ senderId, senderName }`.
 * - Phone numbers (e.g. `+91 98765 43210` for former/unsaved members) map to `<digits>@s.whatsapp.net`.
 * - Display names (including `"WhatsApp User"` for deleted accounts) map to a deterministic
 *   `export_<slug>@s.whatsapp.net` JID while keeping `senderName`.
 */
export function resolveExportSender(rawSender: string, explicitSenderId?: string): {
  senderId: string;
  senderName: string | null;
} {
  const cleanName = stripFormattingMarks(rawSender).trim();
  if (explicitSenderId?.trim()) {
    const sid = explicitSenderId.trim();
    return {
      senderId: sid.includes('@') ? sid : `${sid}@s.whatsapp.net`,
      senderName: cleanName || null,
    };
  }

  if (!cleanName) {
    return { senderId: 'export_unknown@s.whatsapp.net', senderName: null };
  }

  if (cleanName.includes('@')) {
    return { senderId: cleanName, senderName: null };
  }

  // Phone-number sender (e.g. "+91 98765 43210", "+1 (555) 234-5678")
  if (/^\+?[\d\s().-]{7,22}$/.test(cleanName)) {
    const digits = cleanName.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
      return { senderId: `${digits}@s.whatsapp.net`, senderName: cleanName };
    }
  }

  const slug = cleanName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  const hash = createHash('sha1').update(cleanName.toLowerCase()).digest('hex').slice(0, 8);
  const handle = slug ? `export_${slug}_${hash}` : `export_${hash}`;
  return {
    senderId: `${handle}@s.whatsapp.net`,
    senderName: cleanName,
  };
}

function parseDateAndTime(datePart: string, timePart: string, dayFirst = true): number | null {
  const dTokens = datePart.split(/[/.-]/).map((n) => Number(n));
  if (dTokens.length !== 3 || dTokens.some((n) => !Number.isFinite(n))) return null;

  const [first, second] = dTokens;
  let year = dTokens[2];
  if (year < 100) {
    year += year >= 70 ? 1900 : 2000;
  }

  let day: number;
  let month: number;
  if (first > 12) {
    day = first;
    month = second;
  } else if (second > 12) {
    month = first;
    day = second;
  } else if (dayFirst) {
    day = first;
    month = second;
  } else {
    month = first;
    day = second;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const cleanTime = timePart.replace(/[\u202f\u00a0]/g, ' ').trim();
  const tMatch = cleanTime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp][Mm]))?$/);
  if (!tMatch) return null;

  let hours = Number(tMatch[1]);
  const minutes = Number(tMatch[2]);
  const seconds = tMatch[3] ? Number(tMatch[3]) : 0;
  const meridiem = tMatch[4]?.toUpperCase();

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === 'PM' && hours < 12) hours += 12;
    if (meridiem === 'AM' && hours === 12) hours = 0;
  } else if (hours < 0 || hours > 23) {
    return null;
  }

  const ts = Date.UTC(year, month - 1, day, hours, minutes, seconds);
  return Number.isFinite(ts) ? ts : null;
}

function detectDayFirst(lines: string[]): boolean {
  for (const raw of lines) {
    const clean = stripFormattingMarks(raw);
    const m = clean.match(HEADER_RE);
    if (!m) continue;
    const parts = m[1].split(/[/.-]/).map((n) => Number(n));
    if (parts[0] > 12) return true;
    if (parts[1] > 12) return false;
  }
  return true;
}

function makeImportId(groupId: string, timestamp: number, senderId: string, text: string, occurrence: number): string {
  const digest = createHash('sha1')
    .update(`${groupId}\0${timestamp}\0${senderId}\0${text}\0${occurrence}`)
    .digest('hex')
    .slice(0, 24);
  return `import_${digest}`;
}

/**
 * Parses a WhatsApp "Export chat (Without media)" `.txt` string into `StoredMessage[]`.
 * Preserves messages from active, former, and deleted group members while skipping system
 * notices and `<Media omitted>` placeholders.
 */
export function parseWhatsAppExportText(groupId: string, exportText: string): StoredMessage[] {
  if (!exportText?.trim()) return [];

  const lines = exportText.replace(/\r\n?/g, '\n').split('\n');
  const dayFirst = detectDayFirst(lines);

  interface RawEntry {
    timestamp: number;
    senderRaw: string;
    bodyLines: string[];
    isSystem: boolean;
  }

  const entries: RawEntry[] = [];
  let current: RawEntry | null = null;

  for (const rawLine of lines) {
    const cleanLine = stripFormattingMarks(rawLine);
    const match = cleanLine.match(HEADER_RE);
    if (match) {
      const ts = parseDateAndTime(match[1], match[2], dayFirst);
      if (ts !== null) {
        if (current) entries.push(current);
        const rest = match[3];
        const colonIdx = rest.indexOf(': ');
        if (colonIdx <= 0) {
          current = { timestamp: ts, senderRaw: '', bodyLines: [rest], isSystem: true };
        } else {
          const senderRaw = rest.slice(0, colonIdx).trim();
          const firstLine = rest.slice(colonIdx + 2);
          current = {
            timestamp: ts,
            senderRaw,
            bodyLines: [firstLine],
            isSystem: !senderRaw,
          };
        }
        continue;
      }
    }

    if (current && !current.isSystem) {
      current.bodyLines.push(rawLine.replace(DIRECTIONAL_MARKS, ''));
    }
  }
  if (current) entries.push(current);

  const occurrenceCounts = new Map<string, number>();
  const out: StoredMessage[] = [];
  let lastTs = 0;
  let sameMinuteOffset = 0;

  for (const entry of entries) {
    if (entry.isSystem) continue;
    const text = entry.bodyLines.join('\n').trim();
    if (!text || OMITTED_MEDIA_RE.test(text) || SYSTEM_BODY_RE.test(text)) continue;

    // Preserve intra-minute ordering when the export only has HH:MM precision
    let timestamp = entry.timestamp;
    if (timestamp === lastTs) {
      sameMinuteOffset += 1;
      timestamp += sameMinuteOffset;
    } else {
      lastTs = entry.timestamp;
      sameMinuteOffset = 0;
    }

    const { senderId, senderName } = resolveExportSender(entry.senderRaw);
    const sig = `${entry.timestamp}\0${senderId}\0${text}`;
    const occurrence = (occurrenceCounts.get(sig) ?? 0) + 1;
    occurrenceCounts.set(sig, occurrence);

    out.push({
      id: makeImportId(groupId, entry.timestamp, senderId, text, occurrence),
      groupId,
      senderId,
      senderName,
      text,
      timestamp,
      isBot: false,
      quotedMessageId: null,
      quotedParticipant: null,
      mentionedJids: [],
    });
  }

  return out;
}

/**
 * Normalizes structured JSON messages into `StoredMessage[]` with deterministic IDs when omitted.
 */
export function normalizeStructuredMessages(
  groupId: string,
  items: StructuredImportMessage[],
): StoredMessage[] {
  const occurrenceCounts = new Map<string, number>();
  const out: StoredMessage[] = [];

  for (const item of items) {
    const text = item.text?.trim();
    if (!text || OMITTED_MEDIA_RE.test(text)) continue;

    const { senderId, senderName } = resolveExportSender(
      item.senderName ?? '',
      item.senderId,
    );
    const ts = Number(item.timestamp);
    if (!Number.isFinite(ts) || ts < 0) continue;

    const sig = `${ts}\0${senderId}\0${text}`;
    const occurrence = (occurrenceCounts.get(sig) ?? 0) + 1;
    occurrenceCounts.set(sig, occurrence);

    const id = item.id?.trim() || makeImportId(groupId, ts, senderId, text, occurrence);
    out.push({
      id,
      groupId,
      senderId,
      senderName,
      text,
      timestamp: ts,
      isBot: false,
      quotedMessageId: null,
      quotedParticipant: null,
      mentionedJids: [],
    });
  }

  return out;
}
