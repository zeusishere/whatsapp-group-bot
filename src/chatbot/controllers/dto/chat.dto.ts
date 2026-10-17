import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class ChatDto {
  @ApiPropertyOptional({ description: 'Existing conversation thread id (ULID)' })
  @IsOptional()
  @IsString()
  sessionId?: string;

  @ApiPropertyOptional({ description: 'WhatsApp device session to bind a new thread to' })
  @IsOptional()
  @IsUUID()
  deviceSessionId?: string;

  @ApiPropertyOptional({ example: '120363000000000000@g.us', description: 'Group JID; required with deviceSessionId' })
  @IsOptional()
  @IsString()
  @Matches(/^[^\s@]+@g\.us$/, { message: 'groupId must be a WhatsApp group JID (...@g.us)' })
  groupId?: string;

  @ApiProperty({ example: 'What did we decide about the launch date?' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  message: string;
}
