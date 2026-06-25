-- MFA was removed from the product flow to keep first login simple for clients.
ALTER TABLE "Usuario"
    DROP COLUMN IF EXISTS "mfaEnabled",
    DROP COLUMN IF EXISTS "mfaSecret";
