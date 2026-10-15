-- AlterTable
ALTER TABLE "users" ADD COLUMN "chat_id" BIGINT,
ADD COLUMN "characters" JSONB,
ADD COLUMN "characters_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "exbo_link_states" (
    "stateHash" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exbo_link_states_pkey" PRIMARY KEY ("stateHash")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_chat_id_key" ON "users"("chat_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "telegram_subscribers"("chatId") ON DELETE SET NULL ON UPDATE CASCADE;
