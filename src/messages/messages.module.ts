import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller.js';
import { MessagesRepository } from './messages.repository.js';

@Module({
  controllers: [MessagesController],
  providers: [MessagesRepository],
  exports: [MessagesRepository],
})
export class MessagesModule {}
