-- AlterTable
ALTER TABLE "telegram_subscribers" ADD COLUMN     "radar_regions" TEXT[] DEFAULT ARRAY[]::TEXT[];
