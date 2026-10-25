-- CreateTable
CREATE TABLE "reviews" (
    "id" SERIAL NOT NULL,
    "chatId" BIGINT NOT NULL,
    "userId" TEXT NOT NULL,
    "nick" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "channelMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "moderatedAt" TIMESTAMP(3),

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reviews_status_createdAt_idx" ON "reviews"("status", "createdAt");

-- CreateIndex
CREATE INDEX "reviews_chatId_createdAt_idx" ON "reviews"("chatId", "createdAt");
