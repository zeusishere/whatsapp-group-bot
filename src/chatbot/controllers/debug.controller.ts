import { Controller, Get, Header, Param, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthUser } from '../../auth/auth.types.js';
import { CurrentUser } from '../../auth/decorators.js';
import { TraceInspectorService } from '../inspector/trace-inspector.service.js';

@ApiTags('debug')
@ApiBearerAuth()
@Controller('debug')
export class DebugController {
  constructor(private readonly inspector: TraceInspectorService) {}

  @Get('traces/:turnId')
  @ApiOperation({ summary: 'Full execution DAG, timeline and Mermaid flowchart for a turn' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'mermaid'] })
  inspectTurn(
    @CurrentUser() user: AuthUser,
    @Param('turnId') turnId: string,
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (format === 'mermaid') {
      res.type('text/plain');
      return this.inspector.generateMermaidTrace(turnId, user);
    }
    return this.inspector.inspectTurn(turnId, user);
  }

  @Get('messages/:messageId/trace')
  @ApiOperation({ summary: 'Trace for the turn that produced or consumed a chat message' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'mermaid'] })
  @Header('Cache-Control', 'no-store')
  inspectMessage(
    @CurrentUser() user: AuthUser,
    @Param('messageId') messageId: string,
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const view = this.inspector.inspectMessage(messageId, user);
    if (format === 'mermaid') {
      res.type('text/plain');
      return view.mermaid;
    }
    return view;
  }
}
