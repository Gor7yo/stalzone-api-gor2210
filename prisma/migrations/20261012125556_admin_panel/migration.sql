-- AlterTable
ALTER TABLE "telegram_subscribers" ADD COLUMN     "banReason" TEXT,
ADD COLUMN     "bannedUntil" TIMESTAMP(3),
ADD COLUMN     "lastSeenAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "activity_days" (
    "day" DATE NOT NULL,
    "chatId" BIGINT NOT NULL,

    CONSTRAINT "activity_days_pkey" PRIMARY KEY ("day","chatId")
);

-- CreateTable
CREATE TABLE "admin_logs" (
    "id" TEXT NOT NULL,
    "adminId" BIGINT NOT NULL,
    "targetId" BIGINT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_logs_createdAt_idx" ON "admin_logs"("createdAt");
