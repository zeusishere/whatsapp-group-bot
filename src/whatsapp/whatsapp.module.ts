import { Module } from '@nestjs/common';
import { MessagesModule } from '../messages/messages.module.js';
import { WhatsappController } from './whatsapp.controller.js';
import { WhatsappService } from './whatsapp.service.js';

@Module({
  imports: [MessagesModule],
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
