ALTER TABLE "bot_apod_expedientes"
  ADD COLUMN "phaseOneStartedAt" TIMESTAMP(3),
  ADD COLUMN "phaseOneClosedAt" TIMESTAMP(3),
  ADD COLUMN "phaseOneOutcome" TEXT,
  ADD COLUMN "phaseOneEvidence" JSONB;

ALTER TABLE "bot_apod_triggers" ADD COLUMN "provenance" JSONB;

-- Preserve the first accepted contact of existing conversations, not the last silence cycle.
UPDATE "bot_apod_expedientes" e SET "phaseOneStartedAt" = m.started
FROM (SELECT "expedienteId", MIN("createdAt") AS started FROM "bot_apod_messages"
      WHERE role = 'assistant' AND source = 'OUTBOX_ACCEPTED' GROUP BY "expedienteId") m
WHERE e.id = m."expedienteId";

CREATE INDEX "bot_apod_expedientes_phaseOneClosedAt_phaseOneStartedAt_idx"
  ON "bot_apod_expedientes"("phaseOneClosedAt", "phaseOneStartedAt");
