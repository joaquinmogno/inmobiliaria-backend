ALTER TABLE "Usuario"
ADD COLUMN "googleId" TEXT,
ADD COLUMN "authProvider" TEXT NOT NULL DEFAULT 'LOCAL';

CREATE UNIQUE INDEX "Usuario_googleId_key" ON "Usuario"("googleId");
