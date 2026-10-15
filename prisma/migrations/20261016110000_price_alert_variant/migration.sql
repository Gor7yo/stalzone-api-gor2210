-- Ценовой алерт на модуль - с ключевой характеристикой («Снайпер», «Садист»…); '' - любая

-- AlterTable
ALTER TABLE "price_alerts" ADD COLUMN "variant" TEXT NOT NULL DEFAULT '';
