/*
  Warnings:

  - Added the required column `region` to the `clans` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "clans" ADD COLUMN     "region" TEXT NOT NULL;
