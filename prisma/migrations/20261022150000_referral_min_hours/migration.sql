-- AlterTable
ALTER TABLE "referrals" ADD COLUMN     "pendingUntil" TIMESTAMP(3),
ADD COLUMN     "rewardedAt" TIMESTAMP(3);

-- уже начисленные бонусы: время начисления = время приглашения
UPDATE "referrals" SET "rewardedAt" = "createdAt" WHERE "rewarded";

-- CreateIndex
CREATE INDEX "referrals_pendingUntil_idx" ON "referrals"("pendingUntil");
