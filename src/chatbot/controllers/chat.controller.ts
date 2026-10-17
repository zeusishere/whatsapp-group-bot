import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthUser } from '../../auth/auth.types.js';
import { CurrentUser } from '../../auth/decorators.js';
import { ChatService } from '../pipeline/chat.service.js';
import { ChatDto } from './dto/chat.dto.js';

@ApiTags('chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post()
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Run one conversational turn against a group (or an existing thread)',
    description:
      'Returns 202 when the Idempotency-Key matches an in-flight turn. Provide sessionId to continue a thread, or deviceSessionId + groupId to start one.',
  })
  async ask(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChatDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.chat.handleRest(user, dto, idempotencyKey);
    if (result.inProgress) res.status(202);
    return {
      turnId: result.turnId,
      sessionId: result.sessionId,
      status: result.status,
      reply: result.reply,
    };
  }
}
