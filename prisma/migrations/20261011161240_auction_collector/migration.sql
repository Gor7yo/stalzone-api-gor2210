-- CreateTable
CREATE TABLE "auction_sales" (
    "id" BIGSERIAL NOT NULL,
    "region" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "time" TIMESTAMP(3) NOT NULL,
    "price" BIGINT NOT NULL,
    "amount" INTEGER NOT NULL,
    "quality" INTEGER,
    "upgrade" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "auction_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auction_lots" (
    "id" BIGSERIAL NOT NULL,
    "region" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "amount" INTEGER NOT NULL,
    "startPrice" BIGINT NOT NULL,
    "currentPrice" BIGINT,
    "buyoutPrice" BIGINT NOT NULL,
    "quality" INTEGER,
    "upgrade" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "goneAt" TIMESTAMP(3),

    CONSTRAINT "auction_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracked_items" (
    "region" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "salesPerDay" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "wantedAt" TIMESTAMP(3),
    "nextLotsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextSalesAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLotsAt" TIMESTAMP(3),
    "lastSalesAt" TIMESTAMP(3),
    "backfillOffset" INTEGER DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracked_items_pkey" PRIMARY KEY ("region","itemId")
);

-- CreateIndex
CREATE INDEX "auction_sales_region_itemId_time_idx" ON "auction_sales"("region", "itemId", "time" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "auction_sales_region_itemId_time_price_amount_quality_upgra_key" ON "auction_sales"("region", "itemId", "time", "price", "amount", "quality", "upgrade");

-- CreateIndex
CREATE INDEX "auction_lots_region_itemId_goneAt_idx" ON "auction_lots"("region", "itemId", "goneAt");

-- CreateIndex
CREATE UNIQUE INDEX "auction_lots_region_itemId_startTime_amount_startPrice_buyo_key" ON "auction_lots"("region", "itemId", "startTime", "amount", "startPrice", "buyoutPrice", "quality", "upgrade");

-- CreateIndex
CREATE INDEX "tracked_items_nextLotsAt_idx" ON "tracked_items"("nextLotsAt");

-- CreateIndex
CREATE INDEX "tracked_items_nextSalesAt_idx" ON "tracked_items"("nextSalesAt");
