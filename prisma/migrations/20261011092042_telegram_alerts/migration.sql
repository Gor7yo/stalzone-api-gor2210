-- CreateTable
CREATE TABLE "telegram_subscribers" (
    "chatId" BIGINT NOT NULL,
    "firstName" TEXT,
    "username" TEXT,
    "emissionRegions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_subscribers_pkey" PRIMARY KEY ("chatId")
);

-- CreateTable
CREATE TABLE "price_alerts" (
    "id" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "region" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "quality" INTEGER,
    "upgrade" INTEGER,
    "maxPrice" INTEGER NOT NULL,
    "lastLotKey" TEXT,
    "lastNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_state" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_state_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "price_alerts_region_itemId_idx" ON "price_alerts"("region", "itemId");

-- CreateIndex
CREATE INDEX "price_alerts_chatId_idx" ON "price_alerts"("chatId");

-- AddForeignKey
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "telegram_subscribers"("chatId") ON DELETE CASCADE ON UPDATE CASCADE;
