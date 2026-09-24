ALTER TABLE "AuditLog"
ADD COLUMN "requestId" VARCHAR(100);

CREATE INDEX "AuditLog_requestId_idx" ON "AuditLog"("requestId");
