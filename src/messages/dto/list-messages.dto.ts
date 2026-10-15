import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListMessagesQuery {
  @ApiPropertyOptional({ description: 'Group JID, e.g. 1203630xxxxx@g.us' })
  @IsOptional()
  @IsString()
  groupId?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 50;

  @ApiPropertyOptional({ description: 'Only messages with timestamp (epoch ms) older than this' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  before?: number;
}
