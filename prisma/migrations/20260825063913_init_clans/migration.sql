-- CreateTable
CREATE TABLE "clans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "levelPoints" INTEGER NOT NULL,
    "registration_time" TIMESTAMP(3) NOT NULL,
    "alliance" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "leader" TEXT NOT NULL,
    "member_count" INTEGER NOT NULL,

    CONSTRAINT "clans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clans_tag_key" ON "clans"("tag");
