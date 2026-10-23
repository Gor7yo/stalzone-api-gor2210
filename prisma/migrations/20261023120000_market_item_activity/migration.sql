-- CreateTable
CREATE TABLE "market_item_activity" (
    "region" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lastSaleAt" TIMESTAMP(3),
    "lotsTotal" INTEGER NOT NULL DEFAULT 0,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_item_activity_pkey" PRIMARY KEY ("region","itemId")
);

-- CreateIndex
CREATE INDEX "market_item_activity_checkedAt_idx" ON "market_item_activity"("checkedAt");
