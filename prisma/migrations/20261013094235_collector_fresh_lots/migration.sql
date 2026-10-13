-- AlterTable
ALTER TABLE "tracked_items" ADD COLUMN     "flipScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "freshEverySec" INTEGER,
ADD COLUMN     "nextFreshAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "tracked_items_nextFreshAt_idx" ON "tracked_items"("nextFreshAt");
