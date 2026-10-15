import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/api-key.guard.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { WhatsappService } from './whatsapp.service.js';

@ApiTags('whatsapp')
@ApiHeader({ name: 'x-api-key', required: true })
@UseGuards(ApiKeyGuard)
@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsapp: WhatsappService) {}

  @Post('connect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start the WhatsApp session (emits a QR if not yet linked)' })
  connect() {
    return this.whatsapp.connect();
  }

  @Post('disconnect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close the socket but keep credentials' })
  disconnect() {
    return this.whatsapp.disconnect();
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Log out the linked device and wipe the stored session' })
  logout() {
    return this.whatsapp.logout();
  }

  @Get('status')
  @ApiOperation({ summary: 'Connection state, bot JID, reconnect info' })
  status() {
    return this.whatsapp.status();
  }

  @Get('qr')
  @ApiOperation({ summary: 'Current QR code (raw string + PNG data URL) while in qr_pending state' })
  qr() {
    return this.whatsapp.getQr();
  }

  @Get('groups')
  @ApiOperation({ summary: 'Groups the bot account participates in (requires connection)' })
  async groups() {
    return { groups: await this.whatsapp.listGroups() };
  }

  @Post('send')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a text message (manual test helper)' })
  send(@Body() dto: SendMessageDto) {
    return this.whatsapp.sendMessage(dto);
  }
}
