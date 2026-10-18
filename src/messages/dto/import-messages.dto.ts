import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ImportMessageItemDto {
  @ApiPropertyOptional({ description: 'Optional message ID (deterministic hash generated if omitted)' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  id?: string;

  @ApiPropertyOptional({ description: 'Optional sender JID/LID or phone number' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  senderId?: string;

  @ApiPropertyOptional({ description: 'Sender display name (preserved even for former/deleted members)' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  senderName?: string;

  @ApiProperty({ description: 'Message text content' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  text: string;

  @ApiProperty({ description: 'Message timestamp in epoch milliseconds' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  timestamp: number;
}

export class ImportMessagesDto {
  @ApiProperty({ example: '120363000000000000@g.us', description: 'Target WhatsApp group JID' })
  @IsString()
  @Matches(/^[^\s@]+@g\.us$/, { message: 'groupId must be a valid WhatsApp group JID (...@g.us)' })
  groupId: string;

  @ApiPropertyOptional({
    description: 'Raw contents of a WhatsApp "Export chat (Without media)" .txt file',
    example: '12/05/2024, 10:30 pm - Rahul (old member): We finalized the vendor contract.',
  })
  @IsOptional()
  @IsString()
  exportText?: string;

  @ApiPropertyOptional({
    description: 'Structured messages to import (including messages from former/deleted group members)',
    type: [ImportMessageItemDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => ImportMessageItemDto)
  messages?: ImportMessageItemDto[];
}
