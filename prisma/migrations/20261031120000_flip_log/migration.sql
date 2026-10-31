-- CreateTable
CREATE TABLE "flip_log" (
    "region" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quality" INTEGER NOT NULL,
    "upgrade" INTEGER NOT NULL,
    "variant" TEXT NOT NULL DEFAULT '',
    "amount" INTEGER NOT NULL,
    "buyout" BIGINT NOT NULL,
    "sellUnit" BIGINT NOT NULL,
    "profit" BIGINT NOT NULL,
    "pct" DOUBLE PRECISION NOT NULL,
    "confidence" TEXT NOT NULL,
    "deals" INTEGER NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flip_log_pkey" PRIMARY KEY ("region","key")
);

-- CreateIndex
CREATE INDEX "flip_log_region_seenAt_idx" ON "flip_log"("region", "seenAt");
