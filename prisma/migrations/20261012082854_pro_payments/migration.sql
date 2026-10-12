-- CreateTable
CREATE TABLE "pro_payments" (
    "id" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "event" TEXT NOT NULL,
    "amount" INTEGER,
    "currency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pro_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pro_payments_chatId_idx" ON "pro_payments"("chatId");
