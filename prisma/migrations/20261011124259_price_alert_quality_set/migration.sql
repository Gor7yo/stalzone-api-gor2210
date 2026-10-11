-- AlterTable
ALTER TABLE "price_alerts" ADD COLUMN     "qualities" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
