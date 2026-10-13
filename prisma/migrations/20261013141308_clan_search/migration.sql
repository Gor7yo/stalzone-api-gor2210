-- Триграммы для поиска кланов по подстроке (расширение «доверенное»: создаёт владелец БД)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Старые записи — без ключей поиска и устарели; ClanSyncService заполнит таблицу заново
DELETE FROM "clans";

-- AlterTable
ALTER TABLE "clans" ADD COLUMN     "alliance" TEXT,
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "leaderKey" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "levelPoints" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "memberCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nameKey" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "rank" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "registrationTime" TIMESTAMP(3),
ADD COLUMN     "searchKey" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "tagKey" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "clans_region_rank_idx" ON "clans"("region", "rank");

-- CreateIndex
CREATE INDEX "clans_searchKey_idx" ON "clans" USING GIN ("searchKey" gin_trgm_ops);
