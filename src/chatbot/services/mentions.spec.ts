import { GroupMember } from '../../messages/messages.repository.js';
import { openTestDb } from '../testing/harness.js';
import {
  annotateMentions,
  expandMemberQueries,
  formatMembersBlock,
  isMentionOrMemberQuery,
  resolveMentions,
} from './mentions.js';

const MEMBERS: GroupMember[] = [
  { jid: '269341845127193@lid', handle: '269341845127193', name: 'Shubham' },
  { jid: '73684542824592@lid', handle: '73684542824592', name: 'Vinay Jampana' },
  { jid: '234350612344872@lid', handle: '234350612344872', name: 'Kashi' },
  { jid: '10857694101704@lid', handle: '10857694101704', name: 'Khü Shï' },
];

describe('mentions helpers', () => {
  it('formats <members> block with sanitized names and @handles', () => {
    const block = formatMembersBlock(MEMBERS);
    expect(block).toContain('<members>');
    expect(block).toContain('- Shubham: @269341845127193');
    expect(block).toContain('- Vinay Jampana: @73684542824592');
    expect(block).toContain('- Khü Shï: @10857694101704');
    expect(block).toContain('</members>');
  });

  it('annotates @handle mentions in message text with member names', () => {
    const out = annotateMentions('Hey @73684542824592 are you coming?', MEMBERS);
    expect(out).toBe('Hey @73684542824592 (Vinay Jampana) are you coming?');
  });

  it('expands search queries between member names and handles', () => {
    expect(expandMemberQueries('where was vinay tagged?', ['vinay tagged'], MEMBERS)).toContain(
      '73684542824592',
    );
    expect(
      expandMemberQueries('what did @73684542824592 say?', ['73684542824592'], MEMBERS),
    ).toContain('Vinay Jampana');
    expect(expandMemberQueries('tag khushi', ['khushi'], MEMBERS)).toContain('10857694101704');
  });

  it('detects mention or member queries', () => {
    expect(isMentionOrMemberQuery('tag vinay and ask him where he is', MEMBERS)).toBe(true);
    expect(isMentionOrMemberQuery('mention @all for dinner', MEMBERS)).toBe(true);
    expect(isMentionOrMemberQuery('who all are in the group?', MEMBERS)).toBe(true);
    expect(isMentionOrMemberQuery('what is the weather today?', MEMBERS)).toBe(false);
  });

  it('resolves explicit @handle in LLM reply into mentionedJids', () => {
    const res = resolveMentions(
      'Hey @73684542824592, where are you right now?',
      'tag vinay and ask him where he is?',
      MEMBERS,
    );
    expect(res.text).toBe('Hey @73684542824592, where are you right now?');
    expect(res.mentionedJids).toEqual(['73684542824592@lid']);
  });

  it('replaces plain name with @handle when user asks to tag/mention a member by name', () => {
    const res = resolveMentions(
      "Hey Vinay, where are you at right now? We're waiting on you!",
      '@239071553126652 tag vinay and ask him where he is?',
      MEMBERS,
    );
    expect(res.text).toBe(
      "Hey @73684542824592, where are you at right now? We're waiting on you!",
    );
    expect(res.mentionedJids).toEqual(['73684542824592@lid']);
  });

  it('replaces @Name or diacritic-folded name (e.g. khushi -> Khü Shï) with @handle', () => {
    const res1 = resolveMentions(
      'Hey @Vinay Jampana, please check this!',
      'ask vinay',
      MEMBERS,
    );
    expect(res1.text).toBe('Hey @73684542824592, please check this!');
    expect(res1.mentionedJids).toEqual(['73684542824592@lid']);

    const res2 = resolveMentions(
      'Hey Khushi, are you joining?',
      'tag khushi and ask if she is joining',
      MEMBERS,
    );
    expect(res2.text).toBe('Hey @10857694101704, are you joining?');
    expect(res2.mentionedJids).toEqual(['10857694101704@lid']);
  });

  it('expands @all / tag all to mention every group member', () => {
    const res1 = resolveMentions(
      '@all Dinner is at 8pm tonight!',
      'tag all about dinner at 8pm',
      MEMBERS,
    );
    expect(res1.text).toBe(
      '@269341845127193 @73684542824592 @234350612344872 @10857694101704 Dinner is at 8pm tonight!',
    );
    expect(res1.mentionedJids).toEqual([
      '269341845127193@lid',
      '73684542824592@lid',
      '234350612344872@lid',
      '10857694101704@lid',
    ]);

    const res2 = resolveMentions(
      'Hey everyone, dinner is at 8pm tonight!',
      'mention everyone about dinner at 8pm',
      MEMBERS,
    );
    expect(res2.mentionedJids).toEqual([
      '269341845127193@lid',
      '73684542824592@lid',
      '234350612344872@lid',
      '10857694101704@lid',
    ]);
    for (const m of MEMBERS) {
      expect(res2.text).toContain(`@${m.handle}`);
    }
  });

  it('does not turn plain names into mentions when the user did not ask to tag/mention and LLM did not @-mention', () => {
    const res = resolveMentions(
      'Vinay said he will be there at 8pm.',
      'what did Vinay say yesterday?',
      MEMBERS,
    );
    expect(res.text).toBe('Vinay said he will be there at 8pm.');
    expect(res.mentionedJids).toEqual([]);
  });

  it('MessagesRepository.listGroupMembers collects human members and excludes the bot', () => {
    const h = openTestDb();
    h.database.connection
      .prepare('UPDATE sessions SET jid = ?, lid = ? WHERE id = ?')
      .run('919063108886@s.whatsapp.net', '239071553126652@lid', h.deviceSessionId);

    h.insertMessage({
      id: 'm1',
      senderId: '73684542824592@lid',
      senderName: 'Vinay Jampana',
      text: 'Hello',
      timestamp: 1000,
    });
    h.insertMessage({
      id: 'm2',
      senderId: '269341845127193@lid',
      senderName: 'Shubham',
      text: '@239071553126652 tag @234350612344872',
      mentionedJids: ['239071553126652@lid', '234350612344872@lid'],
      timestamp: 2000,
    });
    h.insertMessage({
      id: 'm3',
      senderId: '919063108886@s.whatsapp.net',
      senderName: null,
      text: 'Bot reply',
      isBot: true,
      timestamp: 3000,
    });

    const members = h.messages.listGroupMembers(h.deviceSessionId, h.groupId);
    expect(members).toEqual([
      { jid: '269341845127193@lid', handle: '269341845127193', name: 'Shubham' },
      { jid: '73684542824592@lid', handle: '73684542824592', name: 'Vinay Jampana' },
    ]);
  });
});
