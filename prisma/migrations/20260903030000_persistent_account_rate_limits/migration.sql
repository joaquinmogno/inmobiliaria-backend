-- PC-020: los intentos de login se aíslan por IP + cuenta y sobreviven reinicios.
-- La clave es un HMAC; no se persisten emails, IPs ni credenciales en claro.
CREATE TABLE "LoginThrottle" (
    "key" VARCHAR(64) NOT NULL,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "firstFailureAt" TIMESTAMP(3) NOT NULL,
    "lastFailureAt" TIMESTAMP(3) NOT NULL,
    "blockedUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LoginThrottle_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "LoginThrottle_expiresAt_idx" ON "LoginThrottle"("expiresAt");
