# STALZONE Backend

Backend для приложения, интегрированного с STALZONE API.

Проект отвечает за авторизацию пользователей через STALZONE OAuth, работу с STALZONE API и хранение данных пользователей.

## Стек

- [NestJS](https://nestjs.com/)
- [TypeScript](https://www.typescriptlang.org/)
- [PostgreSQL](https://www.postgresql.org/)
- [Prisma](https://www.prisma.io/)
- Axios / `@nestjs/axios`
- STALZONE OAuth 2.0 API

## Возможности

- Авторизация пользователей через STALZONE
- OAuth 2.0 Authorization Code Flow
- Получение access token и refresh token STALZONE
- Получение информации об авторизованном игроке
- Создание пользователя в PostgreSQL
- Хранение STALZONE OAuth credentials
- Обновление сохранённых OAuth credentials
- Защита OAuth flow с помощью `state`

## Environment Variables

Для работы приложения необходимо создать файл `.env` в корне проекта.

```env
# Application
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/stalzone"

# STALZONE OAuth
STALZONE_CLIENT_ID=
STALZONE_CLIENT_SECRET=
STALZONE_REDIRECT_URI="http://localhost:3000/auth/stalzone/callback"
STALZONE_OAUTH_URL="https://exbo.net"