import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class SendMessageDto {
  @ApiProperty({ example: '120363000000000000@g.us', description: 'Group or user JID' })
  @IsString()
  @Matches(/^[^\s@]+@(g\.us|s\.whatsapp\.net|lid)$/, { message: 'jid must be a valid WhatsApp JID' })
  jid: string;

  @ApiProperty({ example: 'Hello from the bot' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  text: string;

  @ApiPropertyOptional({ description: 'ID of a stored message in the same chat to reply to' })
  @IsOptional()
  @IsString()
  quotedMessageId?: string;
}
