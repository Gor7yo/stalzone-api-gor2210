import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Служебные эндпоинты (статус сборщика и т.п.): только с заголовком
 * `X-Admin-Token: <ADMIN_TOKEN>`. Без ADMIN_TOKEN в .env открыты лишь при разработке.
 * Чужим отвечаем 404, чтобы не выдавать, что эндпоинт существует.
 */
@Injectable()
export class ServerGuard implements CanActivate {
  private readonly token: string;
  private readonly dev: boolean;

  constructor(config: ConfigService) {
    this.token = config.get<string>('ADMIN_TOKEN')?.trim() ?? '';
    this.dev = process.env.NODE_ENV !== 'production';
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.token) {
      if (this.dev) return true;
      throw new NotFoundException();
    }
    const header = context.switchToHttp().getRequest<Request>().headers[
      'x-admin-token'
    ];
    const given = Buffer.from(typeof header === 'string' ? header : '');
    const expected = Buffer.from(this.token);
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return true;
    }
    throw new NotFoundException();
  }
}
