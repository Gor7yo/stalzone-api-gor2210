# STALZONE INFO - Backend

API, сборщик аукциона и Telegram-бот для [STALZONE INFO](https://stalzone-info.ru) - сайта и Telegram Mini App
для игроков STALZONE: цены аукциона, флиппер, алерты, профили игроков, кланы и выбросы.

> Неофициальный фан-проект. Данные - STALZONE API от EXBO.

## Возможности

- **Сборщик аукциона** - держит в своей БД свежие лоты и историю продаж (RU и EU), чтобы сайт, алерты
  и флиппер не тратили квоту EXBO. Частота обновления зависит от ликвидности предмета и интереса
  пользователей; стартовый список предметов - ручной белый список `src/collector/seed-items.json`.
- **Квота EXBO** - общий бюджет токенов на всё приложение: лимит и время сброса берутся из заголовков
  `x-ratelimit-*`, запросам пользователей - приоритет и резерв, сборщик берёт только остаток.
- **Флиппер** - лоты дешевле рынка: медиана сделок за 7 дней по качеству и заточке, прибыль после
  комиссии 5 %, оценка надёжности. Только для Pro.
- **Telegram-бот** - алерты цены, флип-алерты, начало выброса; привязка сайта к Telegram без пароля.
- **Pro-подписка** - пробный период 3 дня, оплата через [Tribute](https://tribute.tg) (вебхук с проверкой
  подписи, идемпотентность), ручная выдача.
- **Админка** - метрики (пользователи, DAU/WAU/MAU, Pro, выручка, сборщик), поиск по @нику или id,
  выдача Pro и баны на любой срок, журнал действий. Доступ - по Telegram id из `ADMIN_CHAT_IDS`.
- **Вход через EXBO** - OAuth 2.0 Authorization Code Flow с `state`.

## Стек

NestJS 11 · TypeScript · PostgreSQL · Prisma 7 · pnpm · Jest

## Запуск локально

```bash
pnpm install
cp .env.example .env            # заполнить переменные (см. ниже)
npx prisma migrate dev
npx prisma generate
pnpm start:dev                  # http://localhost:3001
```

Проверки:

```bash
npx tsc --noEmit -p tsconfig.json
npx eslint src
npx jest
```

## Переменные окружения

| Переменная | Зачем |
|---|---|
| `DATABASE_URL` | PostgreSQL |
| `PORT` | порт API, по умолчанию 3001 |
| `NODE_ENV` | `production` на сервере |
| `TRUST_PROXY` | `1`, если API за Caddy/nginx (настоящий IP для лимитов) |
| `CORS_PATHS` | адреса фронта через запятую |
| `STALZONE_CLIENT_ID`, `STALZONE_CLIENT_SECRET` | приложение в кабинете разработчика EXBO |
| `STALZONE_OAUTH_URL`, `STALZONE_API_URL` | `https://exbo.net`, `https://eapi.stalzone.com` |
| `STALZONE_REDIRECT_URI` | адрес возврата после входа через EXBO (страница фронта) |
| `TELEGRAM_BOT_TOKEN` | токен бота от @BotFather; без него бот и алерты выключены |
| `TELEGRAM_APP_URL` | ссылка на мини-приложение `https://t.me/<бот>/<приложение>` |
| `TELEGRAM_POLLING` | `false` - не опрашивать бота (если его опрашивает другой процесс) |
| `TRIBUTE_API_KEY` | ключ API Tribute - им проверяется подпись вебхука |
| `TRIBUTE_PRODUCT_ID` / `TRIBUTE_SUBSCRIPTION_ID` | Pro дают только эти товар/подписка (пусто - любые) |
| `ADMIN_TOKEN` | служебные эндпоинты (`X-Admin-Token`): статус сборщика, ручная выдача Pro |
| `ADMIN_CHAT_IDS` | Telegram id админов через запятую - доступ к админке |
| `TOKEN_ENCRYPTION_KEY` | 32 байта в base64 (`openssl rand -base64 32`) - шифрование токенов EXBO |
| `COLLECTOR_ENABLED` | `false` - выключить сборщик |
| `CLAN_SYNC_ENABLED` | `false` - не обновлять список кланов (поиск, список, история для метрик; по умолчанию раз в час, ~80 запросов на все регионы) |
| `COLLECTOR_REGIONS` | регионы сборщика, по умолчанию `ru,eu` |
| `EXBO_TOKENS_PER_MIN`, `EXBO_USER_RESERVE` | лимит EXBO и резерв для людей (по умолчанию 400 и 15 %) |

## Основные эндпоинты

| | |
|---|---|
| `GET /api/auction/...`, `/api/character/...`, `/api/clan/...`, `/api/emission` | данные для сайта |
| `GET /api/me`, `POST /api/me/trial` | статус Pro, пробный период |
| `GET /api/clan/search?region=&q=` | поиск клана по названию, тегу, нику лидера (своя копия списка EXBO) |
| `GET /api/clan/metrics?region=&id=&period=` (week, month, all) | динамика клана: бойцы за сутки/неделю/месяц, пик, место по численности, график |
| `GET /api/clan/analytics?region=` | сводка по кланам региона: рост и отток бойцов, группировки, новые/распущенные, распределения |
| `GET /api/flips?region=` | лента флиппера (Pro) |
| `GET /api/sell/advice?region=&item=&quality=&upgrade=&amount=` | помощник продажи (Pro) |
| `/api/alerts/*` | алерты цены, флипов и выброса |
| `POST /api/payments/tribute` | вебхук Tribute |
| `/api/admin/*` | админка (Telegram id из `ADMIN_CHAT_IDS`) |
| `GET /api/collector/status` | состояние сборщика (`X-Admin-Token`) |
| `GET /api/health` | проверка живости |

Пользователь определяется по Telegram: `Authorization: tma <initData>` в мини-приложении или
`Bearer <токен>` на сайте после привязки через бота.

## Структура

```
src/
  api/          данные для сайта: аукцион, история за период, персонажи, кланы, выбросы
  collector/    сборщик аукциона и чтение лотов/продаж из БД; seed-items.json - список предметов
  clans/        синхронизация списка кланов раз в час (история в clan_snapshots), поиск (pg_trgm) и метрики
  flipper/      расчёт ленты флипов и помощник продажи
  telegram/     бот, алерты, привязка сайта, Pro, Tribute, админка, доступ и баны
  stalzone/     клиент STALZONE API (бюджет токенов) и OAuth EXBO
  auth/, users/ вход через EXBO
  common/, config/, prisma/
prisma/         схема и миграции
scripts/        build-tracked-seed.mjs - пересборка списка сборщика
```

После патча игры список предметов сборщика пересобирается из справочника фронта:

```bash
node scripts/build-tracked-seed.mjs ../stalzone-front-nextjs/public
```

## Деплой

Сервер: Ubuntu 24.04, Node 22, PostgreSQL 16, Caddy (HTTPS для `api.stalzone-info.ru`).
Бэкенд работает службой systemd `stalzone-api` от пользователя `stalzone`, `.env` лежит в `/opt/stalzone/api`.

Обновление после `git push` - одна команда на сервере:

```bash
stalzone-deploy   # git pull, pnpm install, prisma generate + migrate deploy, build, рестарт
```

Логи: `journalctl -u stalzone-api -f`.

Бэкапы: каждую ночь в 04:00 UTC `pg_dump` в `/var/backups/stalzone` (хранятся 7 последних),
плюс еженедельные снимки сервера DigitalOcean. Восстановление:

```bash
systemctl stop stalzone-api
runuser -u postgres -- pg_restore --clean --if-exists -d stalzone /var/backups/stalzone/<файл>.dump
systemctl start stalzone-api
```

Один ключ EXBO - один экземпляр бэкенда: квота 400 токенов/мин общая на приложение.

---

by [gor2210](https://stalzone-info.ru)
