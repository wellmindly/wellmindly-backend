-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "appleId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_appleId_key" ON "User"("appleId");
