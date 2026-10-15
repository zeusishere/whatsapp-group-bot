import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/api-key.guard.js';
import { ListMessagesQuery } from './dto/list-messages.dto.js';
import { MessagesRepository } from './messages.repository.js';

@ApiTags('messages')
@ApiHeader({ name: 'x-api-key', required: true })
@UseGuards(ApiKeyGuard)
@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesRepository) {}

  @Get()
  @ApiOperation({ summary: 'List stored group messages (newest first)' })
  list(@Query() q: ListMessagesQuery) {
    const messages = this.messages.list({ groupId: q.groupId, limit: q.limit, before: q.before });
    return { count: messages.length, messages };
  }

  @Get('groups')
  @ApiOperation({ summary: 'List groups that have stored messages, with counts' })
  groups() {
    return { groups: this.messages.listGroups() };
  }
}
