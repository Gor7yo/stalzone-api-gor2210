-- Основной аккаунт - EXBO: Pro, бан и сессии сайта переезжают на users

-- AlterTable
ALTER TABLE "users" ADD COLUMN "pro_until" TIMESTAMP(3),
ADD COLUMN "trial_used_at" TIMESTAMP(3),
ADD COLUMN "banned_until" TIMESTAMP(3),
ADD COLUMN "ban_reason" TEXT,
ADD COLUMN "last_seen_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "exbo_link_states" ALTER COLUMN "chatId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "telegram_link_codes" ADD COLUMN "userId" TEXT;

-- AlterTable
ALTER TABLE "admin_logs" ALTER COLUMN "targetId" DROP NOT NULL,
ADD COLUMN "targetUserId" TEXT;

-- AlterTable
ALTER TABLE "pro_payments" ADD COLUMN "userId" TEXT;

-- CreateTable
CREATE TABLE "account_sessions" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_activity_days" (
    "day" DATE NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "account_activity_days_pkey" PRIMARY KEY ("day","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_sessions_tokenHash_key" ON "account_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "account_sessions_userId_idx" ON "account_sessions"("userId");

-- AddForeignKey
ALTER TABLE "account_sessions" ADD CONSTRAINT "account_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
