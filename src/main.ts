import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { corsOrigins } from './config/validation';
import { HttpExceptionFilter } from './http-exception.filter';

// ошибка в фоновой задаче без catch не должна ронять весь сервер (по умолчанию Node завершается)
process.on('unhandledRejection', (reason) => {
  Logger.error(
    `Необработанная ошибка: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    'Process',
  );
});

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // req.rawBody — для проверки подписи вебхука Tribute
    rawBody: true,
  });
  const config = app.get(ConfigService);

  // за nginx/Cloudflare: настоящий IP клиента для лимита запросов
  if (config.get('TRUST_PROXY'))
    app.set('trust proxy', Number(config.get('TRUST_PROXY')) || 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // API отдаёт JSON другому origin'у (фронтенду) — разрешаем кросс-доменное чтение
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  // ответ с 200 лотами — сотни КБ JSON; gzip сжимает его в 8–10 раз
  app.use(compression({ threshold: 1024 }));
  app.use(cookieParser());

  app.enableCors({
    origin: corsOrigins(config.get<string>('CORS_PATHS')),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86_400,
  });

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      stopAtFirstError: true,
    }),
  );
  app.enableShutdownHooks();

  const port = config.get<number>('PORT') ?? 3001;
  await app.listen(port);
  Logger.log(`API запущен на :${port}`, 'Bootstrap');
}
void bootstrap();
