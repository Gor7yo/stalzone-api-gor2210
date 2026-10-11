/*
  Warnings:

  - Made the column `quality` on table `auction_lots` required. This step will fail if there are existing NULL values in that column.
  - Made the column `quality` on table `auction_sales` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "auction_lots" ALTER COLUMN "quality" SET NOT NULL,
ALTER COLUMN "quality" SET DEFAULT -1;

-- AlterTable
ALTER TABLE "auction_sales" ALTER COLUMN "quality" SET NOT NULL,
ALTER COLUMN "quality" SET DEFAULT -1;
