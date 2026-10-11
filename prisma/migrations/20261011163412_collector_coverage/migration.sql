-- AlterTable
ALTER TABLE "tracked_items" ADD COLUMN     "historyFrom" TIMESTAMP(3),
ADD COLUMN     "lotsTotal" INTEGER;

-- Уже догруженные предметы: история полная хотя бы с самой старой записанной сделки
UPDATE "tracked_items" t
SET "historyFrom" = COALESCE(
  (SELECT min(s."time") FROM "auction_sales" s
   WHERE s."region" = t."region" AND s."itemId" = t."itemId"),
  now()
)
WHERE t."backfillOffset" IS NULL;
