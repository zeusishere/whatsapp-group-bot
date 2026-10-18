import { GroupMember, jidHandle, normalizeJid } from '../../messages/messages.repository.js';

const STOPWORDS = new Set([
  'all',
  'and',
  'are',
  'ask',
  'bot',
  'can',
  'for',
  'from',
  'group',
  'have',
  'her',
  'here',
  'hey',
  'him',
  'his',
  'how',
  'mention',
  'not',
  'now',
  'our',
  'out',
  'ping',
  'say',
  'she',
  'tag',
  'tell',
  'that',
  'the',
  'them',
  'then',
  'there',
  'they',
  'this',
  'was',
  'what',
  'when',
  'where',
  'who',
  'why',
  'with',
  'you',
  'your',
]);

export function foldText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

interface MemberEntry {
  member: GroupMember;
  fullFolded: string;
  collapsed: string;
  tokens: string[];
  rawTokens: string[];
}

function buildMemberEntries(members: GroupMember[]): MemberEntry[] {
  const byHandle = new Map<string, GroupMember>();
  for (const m of members) {
    if (!m.handle || !m.jid) continue;
    const existing = byHandle.get(m.handle);
    if (!existing || (!existing.name && m.name)) {
      byHandle.set(m.handle, m);
    }
  }

  return [...byHandle.values()].map((member) => {
    const rawName = member.name?.trim() ?? '';
    const fullFolded = foldText(rawName).replace(/\s+/g, ' ').trim();
    const collapsed = fullFolded.replace(/[^a-z0-9]/g, '');
    const tokens = fullFolded
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
    const rawTokens = rawName
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    return { member, fullFolded, collapsed, tokens, rawTokens };
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatMembersBlock(
  members: GroupMember[],
  sanitize: (s: string) => string = (s) => s,
): string {
  if (!members.length) return '';
  const lines = members.map((m) => {
    const cleanName = m.name ? sanitize(m.name).replace(/\s+/g, ' ').trim() : '';
    return cleanName ? `- ${cleanName}: @${m.handle}` : `- @${m.handle}`;
  });
  return `<members>\n${lines.join('\n')}\n</members>`;
}

export function annotateMentions(text: string, members: GroupMember[]): string {
  if (!text || !members.length || !text.includes('@')) return text;
  const nameByHandle = new Map<string, string>();
  for (const m of members) {
    if (m.handle && m.name?.trim()) {
      nameByHandle.set(m.handle, m.name.trim());
    }
  }
  if (!nameByHandle.size) return text;

  return text.replace(
    /(?<![A-Za-z0-9._%+-])@(\d{5,20})\b(?!\s*\()/g,
    (full, handle: string) => {
      const name = nameByHandle.get(handle);
      return name ? `@${handle} (${name})` : full;
    },
  );
}

export function isMentionOrMemberQuery(question: string, members: GroupMember[]): boolean {
  if (!members.length) return false;
  if (/(?<![A-Za-z0-9._%+-])@(?:all|everyone|everybody)\b/i.test(question)) return true;
  if (/\b(?:tag|mention|ping)\b/i.test(question)) return true;
  if (
    /\b(?:who\s+(?:all\s+)?(?:are|is)\s+(?:in|present)|list\s+(?:of\s+)?(?:all\s+)?(?:members|participants)|group\s+(?:members|participants))\b/i.test(
      question,
    )
  ) {
    return true;
  }
  return false;
}

export function expandMemberQueries(
  question: string,
  rewritten: string[],
  members: GroupMember[],
): string[] {
  const base = rewritten.length > 0 ? [...rewritten] : [question];
  if (!members.length) return base;

  const entries = buildMemberEntries(members);
  const combinedFolded = foldText([question, ...rewritten].join(' '));
  const extra: string[] = [];

  for (const entry of entries) {
    const { member, fullFolded, collapsed, tokens } = entry;
    const hasHandle = new RegExp(`(?<![0-9])${escapeRegex(member.handle)}(?![0-9])`).test(
      combinedFolded,
    );
    const hasName =
      (fullFolded.length >= 3 && combinedFolded.includes(fullFolded)) ||
      (collapsed.length >= 3 &&
        new RegExp(`\\b${escapeRegex(collapsed)}\\b`).test(combinedFolded)) ||
      tokens.some((t) => new RegExp(`\\b${escapeRegex(t)}\\b`).test(combinedFolded));

    if (hasName && !hasHandle) {
      extra.push(member.handle);
    } else if (hasHandle && member.name && !hasName) {
      extra.push(member.name);
    }
  }

  return extra.length > 0 ? [...base, extra.join(' ')] : base;
}

function matchEntryByPhrase(phrase: string, entries: MemberEntry[]): MemberEntry | null {
  const folded = foldText(phrase).replace(/\s+/g, ' ').trim();
  const collapsed = folded.replace(/[^a-z0-9]/g, '');
  if (!collapsed || STOPWORDS.has(collapsed)) return null;

  for (const e of entries) {
    if ((e.fullFolded && e.fullFolded === folded) || (e.collapsed && e.collapsed === collapsed)) {
      return e;
    }
  }
  for (const e of entries) {
    if (e.tokens.includes(folded) || e.tokens.includes(collapsed)) {
      return e;
    }
  }
  return null;
}

function replacePlainNameWithHandle(text: string, entry: MemberEntry): { text: string; replaced: boolean } {
  const { member, rawTokens, collapsed, tokens } = entry;
  const candidates: string[] = [];
  if (member.name?.trim()) candidates.push(member.name.trim());
  for (const rt of rawTokens) {
    if (rt.length >= 3) candidates.push(rt);
  }
  if (collapsed.length >= 3) candidates.push(collapsed);
  for (const t of tokens) {
    if (t.length >= 3) candidates.push(t);
  }

  for (const cand of candidates) {
    const pattern = new RegExp(
      `(?<![@A-Za-z0-9\\u00C0-\\u024F])@?${escapeRegex(cand)}(?![A-Za-z0-9\\u00C0-\\u024F])`,
      'i',
    );
    if (pattern.test(text)) {
      return {
        text: text.replace(pattern, `@${member.handle}`),
        replaced: true,
      };
    }
  }
  return { text, replaced: false };
}

export function resolveMentions(
  reply: string,
  question: string,
  members: GroupMember[],
  inboundMentionedJids: string[] = [],
): { text: string; mentionedJids: string[] } {
  if (!reply) return { text: reply, mentionedJids: [] };

  const entries = buildMemberEntries(members);
  const byHandle = new Map<string, string>();
  for (const e of entries) {
    byHandle.set(e.member.handle, e.member.jid);
  }
  const questionWithoutLeadingBot = question.replace(/^\s*@\d{5,20}\b[,:]?\s*/, '');
  for (const raw of inboundMentionedJids) {
    const jid = normalizeJid(raw);
    const handle = jidHandle(jid);
    if (handle && jid.includes('@') && !byHandle.has(handle)) {
      byHandle.set(handle, jid);
      if (
        new RegExp(`(?<![A-Za-z0-9._%+-])@${escapeRegex(handle)}\\b`).test(
          questionWithoutLeadingBot,
        )
      ) {
        entries.push({
          member: { jid, handle, name: null },
          fullFolded: '',
          collapsed: '',
          tokens: [],
          rawTokens: [],
        });
      }
    }
  }

  let text = reply;

  const replyHasAll = /(?<![A-Za-z0-9._%+-])@(?:all|everyone|everybody)\b/i.test(text);
  const questionWantsAll =
    /(?<![A-Za-z0-9._%+-])@(?:all|everyone|everybody)\b/i.test(questionWithoutLeadingBot) ||
    /\b(?:tag|mention|ping|notify|call)\s+(?:all|everyone|everybody|all\s+members|every\s+member|the\s+(?:whole\s+)?group|whole\s+group)\b/i.test(
      questionWithoutLeadingBot,
    );

  if (replyHasAll && entries.length > 0) {
    const allHandles = entries.map((e) => `@${e.member.handle}`).join(' ');
    text = text.replace(/(?<![A-Za-z0-9._%+-])@(?:all|everyone|everybody)\b/gi, allHandles);
  }

  if (entries.length > 0 && text.includes('@')) {
    text = text.replace(
      /(?<![A-Za-z0-9._%+-])@([A-Za-z\u00C0-\u024F][\w\u00C0-\u024F]*)(?:([ \t]+)([A-Za-z\u00C0-\u024F][\w\u00C0-\u024F]*))?/g,
      (full, w1: string, space: string | undefined, w2: string | undefined) => {
        if (w2) {
          const twoWord = matchEntryByPhrase(`${w1} ${w2}`, entries);
          if (twoWord) return `@${twoWord.member.handle}`;
        }
        const oneWord = matchEntryByPhrase(w1, entries);
        if (oneWord) {
          return w2 ? `@${oneWord.member.handle}${space ?? ' '}${w2}` : `@${oneWord.member.handle}`;
        }
        return full;
      },
    );
  }

  const explicitTagRequest =
    questionWantsAll ||
    /\b(?:tag|mention|ping)\b/i.test(questionWithoutLeadingBot) ||
    (/\b(?:ask|tell|remind|notify)\b/i.test(questionWithoutLeadingBot) &&
      /@\d{5,20}\b/.test(questionWithoutLeadingBot));

  if (explicitTagRequest && entries.length > 0) {
    const qFolded = foldText(questionWithoutLeadingBot);
    const targets: MemberEntry[] = questionWantsAll
      ? [...entries]
      : entries.filter((e) => {
          if (
            new RegExp(`(?<![A-Za-z0-9._%+-])@${escapeRegex(e.member.handle)}\\b`).test(
              questionWithoutLeadingBot,
            )
          ) {
            return true;
          }
          if (e.fullFolded.length >= 3 && qFolded.includes(e.fullFolded)) return true;
          if (
            e.collapsed.length >= 3 &&
            new RegExp(`\\b${escapeRegex(e.collapsed)}\\b`).test(qFolded)
          ) {
            return true;
          }
          return e.tokens.some((t) => new RegExp(`\\b${escapeRegex(t)}\\b`).test(qFolded));
        });

    const missingHandles: string[] = [];
    for (const target of targets) {
      const handleRegex = new RegExp(
        `(?<![A-Za-z0-9._%+-])@${escapeRegex(target.member.handle)}\\b`,
      );
      if (handleRegex.test(text)) continue;

      const replaced = replacePlainNameWithHandle(text, target);
      if (replaced.replaced) {
        text = replaced.text;
      } else {
        missingHandles.push(`@${target.member.handle}`);
      }
    }

    if (missingHandles.length > 0) {
      text = `${missingHandles.join(' ')} ${text}`.trim();
    }
  }

  const mentionedJids: string[] = [];
  const seenJids = new Set<string>();
  for (const match of text.matchAll(/(?<![A-Za-z0-9._%+-])@(\d{5,20})\b/g)) {
    const jid = byHandle.get(match[1]);
    if (jid && !seenJids.has(jid)) {
      seenJids.add(jid);
      mentionedJids.push(jid);
    }
  }

  return { text, mentionedJids };
}
