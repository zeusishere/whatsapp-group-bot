import type { WAMessage } from '@whiskeysockets/baileys';
import { extractGroupMessage } from './message-extractor';

const GROUP = '120363000000000000@g.us';
const BOT = '15550001111@s.whatsapp.net';

const msg = (over: Partial<WAMessage> & Record<string, any>): WAMessage =>
  ({
    key: { remoteJid: GROUP, id: 'ABC', fromMe: false, participant: '15552223333@s.whatsapp.net' },
    pushName: 'Sarah',
    messageTimestamp: 1_700_000_000,
    ...over,
  }) as WAMessage;

describe('extractGroupMessage', () => {
  it('extracts a plain conversation message', () => {
    const out = extractGroupMessage(msg({ message: { conversation: 'hello' } }), BOT);
    expect(out).toMatchObject({
      id: 'ABC',
      groupId: GROUP,
      senderId: '15552223333@s.whatsapp.net',
      senderName: 'Sarah',
      text: 'hello',
      timestamp: 1_700_000_000_000,
      isBot: false,
      quotedMessageId: null,
      mentionedJids: [],
    });
  });

  it('captures mentions and quoted message info from extended text', () => {
    const out = extractGroupMessage(
      msg({
        message: {
          extendedTextMessage: {
            text: '@Bot what did she say?',
            contextInfo: {
              mentionedJid: [BOT],
              stanzaId: 'QUOTED1',
              participant: '15554445555@s.whatsapp.net',
            },
          },
        },
      }),
      BOT,
    );
    expect(out?.mentionedJids).toEqual([BOT]);
    expect(out?.quotedMessageId).toBe('QUOTED1');
    expect(out?.quotedParticipant).toBe('15554445555@s.whatsapp.net');
  });

  it('unwraps ephemeral messages', () => {
    const out = extractGroupMessage(
      msg({ message: { ephemeralMessage: { message: { conversation: 'disappearing' } } } }),
      BOT,
    );
    expect(out?.text).toBe('disappearing');
  });

  it('marks own messages as bot messages using the bot JID', () => {
    const out = extractGroupMessage(
      msg({
        key: { remoteJid: GROUP, id: 'OUT1', fromMe: true },
        message: { conversation: 'hi all' },
      }),
      BOT,
    );
    expect(out).toMatchObject({ isBot: true, senderId: BOT });
  });

  it('ignores non-group chats, media-only and empty messages', () => {
    const dm = msg({
      key: { remoteJid: '15552223333@s.whatsapp.net', id: 'X', fromMe: false },
      message: { conversation: 'dm' },
    });
    expect(extractGroupMessage(dm, BOT)).toBeNull();
    expect(extractGroupMessage(msg({ message: { imageMessage: { mimetype: 'image/png' } } }), BOT)).toBeNull();
    expect(extractGroupMessage(msg({ message: null }), BOT)).toBeNull();
  });
});
