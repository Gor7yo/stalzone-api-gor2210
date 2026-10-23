/**
 * Заглушка сгенерированного клиента Prisma (generated/prisma/client) для jest - подключена
 * через moduleNameMapper в package.json. Юнит-тестам база не нужна, а настоящий клиент
 * лежит вне rootDir. Раньше каждый тест подменял его сам, и при параллельном запуске
 * подмена PrismaService иногда не срабатывала: грузился настоящий сервис и тест падал
 * («Class extends value undefined» / «Cannot find module 'generated/prisma/client'»).
 * Отдельные тесты по-прежнему могут подменить его своим jest.mock.
 */
export class PrismaClient {}

export class PrismaClientKnownRequestError extends Error {
  code = '';
}

export const Prisma = {
  sql: () => ({}),
  raw: () => ({}),
  join: () => ({}),
  empty: {},
  DbNull: null,
  PrismaClientKnownRequestError,
};
