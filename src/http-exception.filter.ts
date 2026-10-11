import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Единый формат ошибок. Для 4xx отдаём причину (её показывает фронт),
 * для 5xx — общий текст: внутренние детали (стек, сообщения библиотек) наружу не уходят.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Внутренняя ошибка сервера';
    /** машинный код ошибки (например pro_required) — фронтенд по нему решает, что показать */
    let code: string | undefined;

    if (exception instanceof HttpException && status < 500) {
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'code' in body) {
        code = String(body.code);
      }
      message =
        typeof body === 'string'
          ? body
          : typeof body === 'object' && body !== null && 'message' in body
            ? (body as { message: string | string[] }).message
            : exception.message;
    } else if (exception instanceof HttpException) {
      // 502/504 от клиента STALCRAFT — сообщения безопасные и полезные
      message = exception.message;
    }

    // путь без query-строки: в логи не попадают ники и прочие параметры
    const path = request.path;
    if (status >= 500 && !(exception instanceof HttpException)) {
      this.logger.error(
        `${request.method} ${path} ${status}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (status >= 500) {
      this.logger.warn(
        `${request.method} ${path} ${status} — ${String(message)}`,
      );
    }

    response.status(status).json({
      statusCode: status,
      ...(code && { code }),
      message,
      path,
      timestamp: new Date().toISOString(),
    });
  }
}
