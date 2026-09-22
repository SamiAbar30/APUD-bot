CREATE TABLE "bot_apod_registrations" (
  "id" TEXT NOT NULL,
  "expedienteId" TEXT NOT NULL,
  "intent" JSONB NOT NULL,
  "intentHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PREPARATION_REQUIRED',
  "version" INTEGER NOT NULL DEFAULT 0,
  "draftDocumentId" TEXT,
  "certificateFingerprint" TEXT,
  "approval" JSONB,
  "attemptId" TEXT,
  "receiptDocumentId" TEXT,
  "registrationReference" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bot_apod_registrations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bot_apod_registrations_expedienteId_fkey" FOREIGN KEY ("expedienteId") REFERENCES "bot_apod_expedientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "bot_apod_registrations_attemptId_key" ON "bot_apod_registrations"("attemptId");
CREATE INDEX "bot_apod_registrations_expedienteId_createdAt_idx" ON "bot_apod_registrations"("expedienteId", "createdAt");
CREATE UNIQUE INDEX "bot_apod_registrations_one_open_case" ON "bot_apod_registrations"("expedienteId") WHERE "status" NOT IN ('CANCELLED', 'REGISTERED_OBSERVED');
