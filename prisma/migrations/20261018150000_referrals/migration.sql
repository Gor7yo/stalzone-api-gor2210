-- Реферальная программа: код ссылки у аккаунта, «кем приглашён» у Telegram, приглашения.
-- AlterTable
ALTER TABLE "telegram_subscribers" ADD COLUMN     "referredBy" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "ref_code" TEXT;

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "rewarded" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referrals_inviteeId_key" ON "referrals"("inviteeId");

-- CreateIndex
CREATE INDEX "referrals_inviterId_createdAt_idx" ON "referrals"("inviterId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "users_ref_code_key" ON "users"("ref_code");

