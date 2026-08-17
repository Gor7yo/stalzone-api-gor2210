/*
  Warnings:

  - You are about to drop the column `createdAt` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `steamId` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `StalzoneAccount` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[uuid]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[login]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `login` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `uuid` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "StalzoneAccount" DROP CONSTRAINT "StalzoneAccount_userId_fkey";

-- DropIndex
DROP INDEX "User_steamId_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "createdAt",
DROP COLUMN "steamId",
DROP COLUMN "updatedAt",
ADD COLUMN     "login" TEXT NOT NULL,
ADD COLUMN     "steam_id" TEXT,
ADD COLUMN     "uuid" TEXT NOT NULL;

-- DropTable
DROP TABLE "StalzoneAccount";

-- CreateIndex
CREATE UNIQUE INDEX "User_uuid_key" ON "User"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "User_login_key" ON "User"("login");
