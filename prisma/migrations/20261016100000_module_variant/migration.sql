-- Ключевая характеристика модуля («Снайпер», «Садист»…) - отдельный вариант предмета для цен и флипов

-- AlterTable
ALTER TABLE "auction_sales" ADD COLUMN "variant" TEXT NOT NULL DEFAULT '';
ALTER TABLE "auction_lots" ADD COLUMN "variant" TEXT NOT NULL DEFAULT '';

-- Отпечаток сделки и лота теперь с вариантом
DROP INDEX "auction_sales_region_itemId_time_price_amount_quality_upgra_key";
CREATE UNIQUE INDEX "auction_sales_region_itemId_time_price_amount_quality_upgra_key" ON "auction_sales"("region", "itemId", "time", "price", "amount", "quality", "upgrade", "variant");
DROP INDEX "auction_lots_region_itemId_startTime_amount_startPrice_buyo_key";
CREATE UNIQUE INDEX "auction_lots_region_itemId_startTime_amount_startPrice_buyo_key" ON "auction_lots"("region", "itemId", "startTime", "amount", "startPrice", "buyoutPrice", "quality", "upgrade", "variant");

-- Старая история оружейного модуля записана без варианта (цены разных модулей вперемешку):
-- удаляем и даём сборщику скачать её заново - сразу, без now() (колонки без часового пояса)
DELETE FROM "auction_sales" WHERE "itemId" = '1pyq';
DELETE FROM "auction_lots" WHERE "itemId" = '1pyq';
UPDATE "tracked_items"
SET "backfillOffset" = 0, "historyFrom" = NULL, "lastSalesAt" = NULL, "lastLotsAt" = NULL,
    "nextSalesAt" = '1970-01-01', "nextLotsAt" = '1970-01-01', "nextFreshAt" = '1970-01-01'
WHERE "itemId" = '1pyq';
