-- CreateTable
CREATE TABLE "telegram_link_codes" (
    "codeHash" TEXT NOT NULL,
    "chatId" BIGINT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_link_codes_pkey" PRIMARY KEY ("codeHash")
);

-- CreateTable
CREATE TABLE "web_sessions" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "web_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "web_sessions_tokenHash_key" ON "web_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "web_sessions_chatId_idx" ON "web_sessions"("chatId");

-- AddForeignKey
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "telegram_subscribers"("chatId") ON DELETE CASCADE ON UPDATE CASCADE;
