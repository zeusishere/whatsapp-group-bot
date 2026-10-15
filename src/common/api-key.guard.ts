import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AppConfig } from '../config/env.schema.js';

/** Protects control endpoints with a static key from env.json (`apiKey`), sent as `x-api-key`. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.header('x-api-key') ?? '';
    const expected = this.config.get('apiKey', { infer: true });

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Missing or invalid x-api-key header');
    }
    return true;
  }
}
