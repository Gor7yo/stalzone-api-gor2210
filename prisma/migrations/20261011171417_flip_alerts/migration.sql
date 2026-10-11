-- CreateTable
CREATE TABLE "flip_alerts" (
    "id" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "region" TEXT NOT NULL,
    "minProfit" INTEGER NOT NULL,
    "minPct" INTEGER NOT NULL DEFAULT 10,
    "minConfidence" TEXT NOT NULL DEFAULT 'medium',
    "maxBudget" INTEGER NOT NULL DEFAULT 0,
    "groups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sentKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flip_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "flip_alerts_chatId_region_key" ON "flip_alerts"("chatId", "region");

-- AddForeignKey
ALTER TABLE "flip_alerts" ADD CONSTRAINT "flip_alerts_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "telegram_subscribers"("chatId") ON DELETE CASCADE ON UPDATE CASCADE;
