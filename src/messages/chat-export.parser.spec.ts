import {
  normalizeStructuredMessages,
  parseWhatsAppExportText,
  resolveExportSender,
} from './chat-export.parser.js';

const GROUP = '120363000000000000@g.us';

describe('chat-export.parser', () => {
  it('parses Android WhatsApp export format with 12h AM/PM, multi-line messages, and former/deleted members', () => {
    const raw = [
      '12/05/2024, 10:15 am - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.',
      '12/05/2024, 10:30 am - Shubham: Hey everyone, welcome to the project group!',
      '12/05/2024, 10:31 am - +91 98765 43210: I am sharing the server credentials doc.',
      'Second line of the message from a member who later left.',
      '12/05/2024, 10:32 am - WhatsApp User: I uploaded the backup archive to S3 bucket prod-backups.',
      '12/05/2024, 10:33 am - +91 98765 43210 left',
      '12/05/2024, 10:34 am - Shubham: <Media omitted>',
    ].join('\n');

    const parsed = parseWhatsAppExportText(GROUP, raw);
    expect(parsed).toHaveLength(3);

    expect(parsed[0]).toMatchObject({
      groupId: GROUP,
      senderName: 'Shubham',
      text: 'Hey everyone, welcome to the project group!',
      isBot: false,
    });
    expect(parsed[0].senderId).toMatch(/^export_shubham_[a-f0-9]{8}@s\.whatsapp\.net$/);

    expect(parsed[1]).toMatchObject({
      groupId: GROUP,
      senderId: '919876543210@s.whatsapp.net',
      senderName: '+91 98765 43210',
      text: 'I am sharing the server credentials doc.\nSecond line of the message from a member who later left.',
    });

    expect(parsed[2]).toMatchObject({
      groupId: GROUP,
      senderName: 'WhatsApp User',
      text: 'I uploaded the backup archive to S3 bucket prod-backups.',
    });
    expect(parsed[2].senderId).toMatch(/^export_whatsapp_user_[a-f0-9]{8}@s\.whatsapp\.net$/);
  });

  it('parses iOS/Desktop bracketed format with 24h and 12h timestamps and 2-digit years', () => {
    const raw = [
      '\u200e[15/08/24, 14:05:10] Vinay Jampana: Deployment starts at 3pm UTC.',
      '[15/08/24, 2:06:00\u202fPM] Kashi: Confirmed, staging is green.',
      '[15/08/24, 2:07:00 PM] Vinay Jampana: \u200eimage omitted',
    ].join('\r\n');

    const parsed = parseWhatsAppExportText(GROUP, raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].senderName).toBe('Vinay Jampana');
    expect(parsed[0].text).toBe('Deployment starts at 3pm UTC.');
    expect(parsed[1].senderName).toBe('Kashi');
    expect(parsed[1].text).toBe('Confirmed, staging is green.');
  });

  it('produces deterministic message IDs so re-importing the same export is idempotent', () => {
    const raw = [
      '20/09/2024, 09:00 - Alice: Same message',
      '20/09/2024, 09:00 - Alice: Same message',
    ].join('\n');

    const firstRun = parseWhatsAppExportText(GROUP, raw);
    const secondRun = parseWhatsAppExportText(GROUP, raw);

    expect(firstRun).toHaveLength(2);
    expect(firstRun[0].id).not.toBe(firstRun[1].id);
    expect(secondRun.map((m) => m.id)).toEqual(firstRun.map((m) => m.id));
  });

  it('normalizes structured import messages and preserves former member names', () => {
    const out = normalizeStructuredMessages(GROUP, [
      {
        senderName: 'Former Member Rahul',
        text: 'The API key rotation happens every 90 days.',
        timestamp: 1_700_000_000_000,
      },
      {
        id: 'custom-id-1',
        senderId: '919999988888@s.whatsapp.net',
        senderName: 'Rahul',
        text: 'Second note',
        timestamp: 1_700_000_001_000,
      },
    ]);

    expect(out).toHaveLength(2);
    expect(out[0].id).toMatch(/^import_[a-f0-9]{24}$/);
    expect(out[0].senderName).toBe('Former Member Rahul');
    expect(out[1].id).toBe('custom-id-1');
    expect(out[1].senderId).toBe('919999988888@s.whatsapp.net');
  });

  it('resolveExportSender handles phone numbers, JIDs, and display names', () => {
    expect(resolveExportSender('+1 (555) 234-5678')).toEqual({
      senderId: '15552345678@s.whatsapp.net',
      senderName: '+1 (555) 234-5678',
    });
    expect(resolveExportSender('73684542824592@lid')).toEqual({
      senderId: '73684542824592@lid',
      senderName: null,
    });
  });
});
