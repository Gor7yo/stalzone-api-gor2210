-- AlterTable
ALTER TABLE "clans" ADD COLUMN     "goneAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "clan_snapshots" (
    "clanId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "region" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "memberCount" INTEGER NOT NULL,

    CONSTRAINT "clan_snapshots_pkey" PRIMARY KEY ("clanId","at")
);

-- CreateIndex
CREATE INDEX "clan_snapshots_region_at_idx" ON "clan_snapshots"("region", "at");

-- CreateIndex
CREATE INDEX "clans_region_goneAt_idx" ON "clans"("region", "goneAt");

-- CreateIndex
CREATE INDEX "clans_region_level_memberCount_idx" ON "clans"("region", "level" DESC, "memberCount" DESC);
