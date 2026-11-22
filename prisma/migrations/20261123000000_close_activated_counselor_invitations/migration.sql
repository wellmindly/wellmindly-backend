-- Data-only backfill (no schema change). Idempotent: safe to run any number of times.
--
-- Counselors who already activated (a COUNSELOR user with a CounselorProfile exists for the
-- invited email) but whose CounselorInvitation is still open (used = false). That happened when
-- an admin re-invited / approved someone who already had an account, or when the account was
-- created outside setup-profile. Such rows kept the counselor in the admin "Counselor
-- Applications" list and left a live setup link around.
--
-- The admin list no longer depends on this flag (it checks for the account itself), so this
-- only closes stale setup links. Added 2026-11-23; NOT applied to production by the author.
UPDATE "CounselorInvitation" AS i
SET "used" = true
WHERE i."used" = false
  AND EXISTS (
    SELECT 1
    FROM "User" u
    JOIN "CounselorProfile" p ON p."userId" = u."id"
    WHERE lower(u."email") = lower(i."email")
      AND u."role" = 'COUNSELOR'
  );
