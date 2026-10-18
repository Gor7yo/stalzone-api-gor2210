-- CreateTable
CREATE TABLE "tracked_characters" (
    "region" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "username_key" TEXT NOT NULL,
    "last_viewed_at" TIMESTAMP(3) NOT NULL,
    "refreshed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracked_characters_pkey" PRIMARY KEY ("region","uuid")
);

-- CreateTable
CREATE TABLE "character_snapshots" (
    "region" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "stats" JSONB NOT NULL,

    CONSTRAINT "character_snapshots_pkey" PRIMARY KEY ("region","uuid","day")
);

-- CreateIndex
CREATE INDEX "tracked_characters_region_username_key_idx" ON "tracked_characters"("region", "username_key");

-- CreateIndex
CREATE INDEX "tracked_characters_last_viewed_at_idx" ON "tracked_characters"("last_viewed_at");

-- CreateIndex
CREATE INDEX "character_snapshots_day_idx" ON "character_snapshots"("day");
