BEGIN;

ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Session" ADD COLUMN "passwordChangeOnly" BOOLEAN NOT NULL DEFAULT false;

-- Preserve passwords already replaced by their owners. The audit ID orders these
-- events because each password update and its audit insertion share a transaction.
WITH last_password_event AS (
  SELECT DISTINCT ON ("objectId") "objectId", "action"
  FROM "AuditLog"
  WHERE "objectId" IS NOT NULL AND "action" IN (
    'credentials.password.reset', 'credentials.admin.recover', 'credentials.password.change'
  )
  ORDER BY "objectId", "id" DESC
)
UPDATE "User" AS u SET "mustChangePassword" = true
FROM last_password_event AS event
WHERE u."id" = event."objectId" AND event."action" <> 'credentials.password.change';

DELETE FROM "Session" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "mustChangePassword");
DELETE FROM "OAuthState" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "mustChangePassword");

COMMIT;
