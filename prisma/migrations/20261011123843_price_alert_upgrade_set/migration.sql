/*
  Warnings:

  - You are about to drop the column `upgradeTo` on the `price_alerts` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "price_alerts" DROP COLUMN "upgradeTo",
ADD COLUMN     "upgrades" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
