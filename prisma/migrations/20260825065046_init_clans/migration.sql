/*
  Warnings:

  - You are about to drop the column `alliance` on the `clans` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `clans` table. All the data in the column will be lost.
  - You are about to drop the column `level` on the `clans` table. All the data in the column will be lost.
  - You are about to drop the column `levelPoints` on the `clans` table. All the data in the column will be lost.
  - You are about to drop the column `member_count` on the `clans` table. All the data in the column will be lost.
  - You are about to drop the column `registration_time` on the `clans` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "clans" DROP COLUMN "alliance",
DROP COLUMN "description",
DROP COLUMN "level",
DROP COLUMN "levelPoints",
DROP COLUMN "member_count",
DROP COLUMN "registration_time";
