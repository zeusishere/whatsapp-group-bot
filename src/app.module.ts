import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { loadConfig } from './config/configuration.js';
import { DatabaseModule } from './database/database.module.js';
import { MessagesModule } from './messages/messages.module.js';
import { WhatsappModule } from './whatsapp/whatsapp.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [loadConfig],
    }),
    DatabaseModule,
    MessagesModule,
    WhatsappModule,
  ],
})
export class AppModule {}
