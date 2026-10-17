import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateSessionDto {
  @ApiPropertyOptional({ example: 'Support number', description: 'Human-friendly name for the device' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}
