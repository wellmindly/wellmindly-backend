-- AlterTable: Apple refresh token, kept only so it can be revoked on account deletion
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "appleRefreshToken" TEXT;
