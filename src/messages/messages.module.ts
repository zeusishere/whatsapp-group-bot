import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module.js';
import { MessagesController } from './messages.controller.js';
import { MessagesRepository } from './messages.repository.js';

@Module({
  imports: [SessionsModule],
  controllers: [MessagesController],
  providers: [MessagesRepository],
  exports: [MessagesRepository],
})
export class MessagesModule {}
