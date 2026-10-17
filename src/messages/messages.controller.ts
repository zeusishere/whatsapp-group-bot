import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { SessionsRepository } from '../sessions/sessions.repository.js';
import { ListMessagesQuery } from './dto/list-messages.dto.js';
import { MessagesRepository } from './messages.repository.js';

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
}
