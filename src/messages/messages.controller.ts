import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { SessionsRepository } from '../sessions/sessions.repository.js';
import { normalizeStructuredMessages, parseWhatsAppExportText } from './chat-export.parser.js';
import { ImportMessagesDto } from './dto/import-messages.dto.js';
import { ListMessagesQuery } from './dto/list-messages.dto.js';
import { MessagesRepository, StoredMessage } from './messages.repository.js';

@ApiTags('messages')
@ApiBearerAuth()
@Controller('sessions/:sessionId/messages')
export class MessagesController {
  constructor(
    private readonly messages: MessagesRepository,
    private readonly sessions: SessionsRepository,
  ) {}

  @Get()
  @ApiOperation({ summary: "List a session's stored group messages (newest first)" })
  list(
    @CurrentUser() user: AuthUser,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Query() q: ListMessagesQuery,
  ) {
    this.sessions.requireAccessible(sessionId, user);
    const messages = this.messages.list({ sessionId, groupId: q.groupId, limit: q.limit, before: q.before });
    return { count: messages.length, messages };
  }

  @Get('groups')
  @ApiOperation({ summary: 'Groups of this session that have stored messages, with counts' })
  groups(@CurrentUser() user: AuthUser, @Param('sessionId', new ParseUUIDPipe()) sessionId: string) {
    this.sessions.requireAccessible(sessionId, user);
    return { groups: this.messages.listGroups(sessionId) };
  }

  @Post('import')
  @ApiOperation({
    summary:
      'Import historical group messages (including from former/deleted members) from a WhatsApp .txt chat export or JSON array',
  })
  importMessages(
    @CurrentUser() user: AuthUser,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Body() dto: ImportMessagesDto,
  ) {
    this.sessions.requireAccessible(sessionId, user);
    if (!dto.exportText?.trim() && (!dto.messages || dto.messages.length === 0)) {
      throw new BadRequestException('Provide exportText or messages to import');
    }

    const parsed: StoredMessage[] = [];
    if (dto.exportText?.trim()) {
      parsed.push(...parseWhatsAppExportText(dto.groupId, dto.exportText));
    }
    if (dto.messages?.length) {
      parsed.push(...normalizeStructuredMessages(dto.groupId, dto.messages));
    }

    let inserted = 0;
    for (const msg of parsed) {
      if (this.messages.insert(sessionId, msg)) {
        inserted += 1;
      }
    }

    return {
      groupId: dto.groupId,
      totalParsed: parsed.length,
      inserted,
      duplicatesSkipped: parsed.length - inserted,
    };
  }
}
