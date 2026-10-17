import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { WhatsappService } from './whatsapp.service.js';

const Id = () => Param('id', new ParseUUIDPipe());

@ApiTags('sessions')
@ApiBearerAuth()
@Controller('sessions')
export class WhatsappController {
  constructor(private readonly whatsapp: WhatsappService) {}

  @Post()
  @ApiOperation({ summary: 'Create a session (a slot for one WhatsApp device). Does not connect yet' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSessionDto) {
    return this.whatsapp.create(user, dto.label?.trim() || null);
  }

  @Get()
  @ApiOperation({ summary: 'Your sessions with live status (admins see all)' })
  async list(@CurrentUser() user: AuthUser) {
    return { sessions: this.whatsapp.list(user) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Status of one session: state, desired state, JID, reconnect info' })
  status(@CurrentUser() user: AuthUser, @Id() id: string) {
    return this.whatsapp.status(user, id);
  }

  @Post(':id/connect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start the session. Returns the QR (qr + qrDataUrl) if the device is not yet linked; it is restored on boot afterwards' })
  connect(@CurrentUser() user: AuthUser, @Id() id: string) {
    return this.whatsapp.connect(user, id);
  }

  @Post(':id/disconnect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close the socket, keep credentials, and stop restoring it on boot' })
  disconnect(@CurrentUser() user: AuthUser, @Id() id: string) {
    return this.whatsapp.disconnect(user, id);
  }

  @Post(':id/logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Log the linked device out and wipe its stored credentials' })
  logout(@CurrentUser() user: AuthUser, @Id() id: string) {
    return this.whatsapp.logout(user, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Log out and delete the session with its credentials and stored messages' })
  remove(@CurrentUser() user: AuthUser, @Id() id: string) {
    return this.whatsapp.remove(user, id);
  }

  @Get(':id/qr')
  @ApiOperation({ summary: 'Current QR code (raw string + PNG data URL) while in qr_pending state' })
  qr(@CurrentUser() user: AuthUser, @Id() id: string) {
    return this.whatsapp.getQr(user, id);
  }

  @Get(':id/groups')
  @ApiOperation({ summary: 'Groups the device participates in (requires connection)' })
  async groups(@CurrentUser() user: AuthUser, @Id() id: string) {
    return { groups: await this.whatsapp.listGroups(user, id) };
  }

  @Post(':id/send')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a text message (manual test helper)' })
  send(@CurrentUser() user: AuthUser, @Id() id: string, @Body() dto: SendMessageDto) {
    return this.whatsapp.sendMessage(user, id, dto);
  }
}
