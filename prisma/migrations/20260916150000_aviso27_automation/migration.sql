ALTER TYPE "ApodState" RENAME VALUE 'HANDOFF_CARMEN' TO 'HANDOFF_DAYANA';
ALTER TYPE "ApodState" ADD VALUE 'FALLBACK_OPTIONS';
ALTER TABLE "bot_apod_expedientes"
  ADD COLUMN "stepReached" TEXT NOT NULL DEFAULT 'INITIAL_TRIAGE',
  ADD COLUMN "stepEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "previousState" TEXT,
  ADD COLUMN "lastOutboundAt" TIMESTAMP(3),
  ADD COLUMN "reminderAnchorAt" TIMESTAMP(3),
  ADD COLUMN "reminderCycle" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reminderCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastReminderDay" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextReminderAt" TIMESTAMP(3),
  ADD COLUMN "automationPaused" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "optOutAt" TIMESTAMP(3),
  ADD COLUMN "priorConversation" BOOLEAN NOT NULL DEFAULT false;
UPDATE "bot_apod_expedientes" SET "stepReached"="currentState"::text, "stepEnteredAt"="updatedAt", "priorConversation"=("lastInboundAt" IS NOT NULL);
UPDATE "bot_apod_expedientes" c SET "previousState"=a."fromState"::text FROM (SELECT DISTINCT ON ("expedienteId") "expedienteId", "fromState" FROM "bot_apod_audit_logs" WHERE "toState"='ESCALATED_HUMAN' AND "fromState" IS NOT NULL AND "fromState"!='ESCALATED_HUMAN' ORDER BY "expedienteId","createdAt" DESC) a WHERE c.id=a."expedienteId" AND c."currentState"='ESCALATED_HUMAN';
UPDATE "bot_apod_expedientes" SET "automationPaused"=true WHERE "currentState"='ESCALATED_HUMAN';
UPDATE "bot_apod_expedientes" c SET "optOutAt"=a."createdAt", "automationPaused"=true FROM (SELECT DISTINCT ON ("expedienteId") "expedienteId","createdAt" FROM "bot_apod_audit_logs" WHERE event='CLIENT_OPT_OUT' ORDER BY "expedienteId","createdAt" DESC) a WHERE c.id=a."expedienteId";
CREATE TABLE "bot_apod_messages" ("id" TEXT PRIMARY KEY, "expedienteId" TEXT NOT NULL REFERENCES "bot_apod_expedientes"("id"), "externalId" TEXT NOT NULL UNIQUE, "role" TEXT NOT NULL, "content" TEXT NOT NULL, "source" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "bot_apod_messages_expedienteId_createdAt_idx" ON "bot_apod_messages"("expedienteId","createdAt");
CREATE TABLE "bot_apod_human_tasks" ("id" TEXT PRIMARY KEY, "expedienteId" TEXT NOT NULL REFERENCES "bot_apod_expedientes"("id"), "dedupeKey" TEXT NOT NULL UNIQUE, "kind" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'OPEN', "assignedTo" TEXT NOT NULL DEFAULT 'DAYANA', "reason" TEXT NOT NULL, "evidence" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolvedAt" TIMESTAMP(3), "resolvedBy" TEXT, "resolutionRef" TEXT);
CREATE INDEX "bot_apod_human_tasks_status_createdAt_idx" ON "bot_apod_human_tasks"("status","createdAt");
CREATE TABLE "bot_apod_triggers" ("id" TEXT PRIMARY KEY, "externalId" TEXT NOT NULL UNIQUE, "projectId" TEXT NOT NULL, "expedienteId" TEXT REFERENCES "bot_apod_expedientes"("id"), "status" TEXT NOT NULL DEFAULT 'PENDING', "evidenceRef" TEXT NOT NULL, "lastError" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "processedAt" TIMESTAMP(3));
CREATE INDEX "bot_apod_triggers_status_createdAt_idx" ON "bot_apod_triggers"("status","createdAt");
-- Preserve queued effects and audit provenance when changing the recipient vocabulary.
UPDATE "bot_apod_acciones" SET "actionType"='NOTIFY_DAYANA' WHERE "actionType"='NOTIFY_CARMEN_RECLAMACIONES';
UPDATE "bot_apod_acciones" SET "payload"=replace(replace(replace("payload"::text,'HANDOFF_CARMEN','HANDOFF_DAYANA'),'NOTIFY_CARMEN_RECLAMACIONES','NOTIFY_DAYANA'),'CARMEN_APODERAMIENTO','DAYANA_APODERAMIENTO')::jsonb;
UPDATE "bot_apod_acciones" SET "receipt"=replace(replace(replace("receipt"::text,'HANDOFF_CARMEN','HANDOFF_DAYANA'),'CARMEN_NOTIFIED','DAYANA_NOTIFIED'),'NOTIFY_CARMEN_RECLAMACIONES','NOTIFY_DAYANA')::jsonb WHERE "receipt" IS NOT NULL;
-- Recover the semantic step for existing records without sending any reminders on migration.
UPDATE "bot_apod_expedientes" SET "stepReached"=CASE COALESCE(CASE WHEN "currentState"='ESCALATED_HUMAN' THEN "previousState" END,"currentState"::text)
 WHEN 'CERT_ACQUISITION_LINKS_SENT' THEN CASE WHEN dni ~ '^[XYZ]' THEN 'ENVIAR_AYUNTAMIENTO_NIE' ELSE 'ENVIAR_LINKS_DNI' END
 WHEN 'PC_TUTORIAL_SENT' THEN 'ENVIAR_PDF_ORDENADOR'
 WHEN 'WAITING_PDF_SUBMISSION' THEN 'ENVIAR_PDF_ORDENADOR'
 WHEN 'MOBILE_EXPORT_GUIDE_SENT' THEN 'INSTALAR_EN_PC_DESDE_MOVIL'
 WHEN 'MOBILE_ASSIST_PROCESSING' THEN CASE WHEN "documentId" IS NULL THEN 'SOLICITUD_CERTIFICADO_PASSWORD' ELSE 'ASISTENCIA_SEGURA' END
 WHEN 'WAITING_CERT_RESPONSE' THEN CASE WHEN "hasDigitalCert" THEN 'CONSULTAR_DISPOSITIVO' ELSE 'CONSULTAR_CERTIFICADO' END
 ELSE COALESCE(CASE WHEN "currentState"='ESCALATED_HUMAN' THEN "previousState" END,"currentState"::text) END;
INSERT INTO "bot_apod_human_tasks" (id,"expedienteId","dedupeKey",kind,reason)
 SELECT md5('migration-review:'||id)::uuid::text,id,'migration-review:'||id,'CONVERSATION_REVIEW','Expediente ya pendiente de atención profesional antes de la migración.' FROM "bot_apod_expedientes" WHERE "currentState"='ESCALATED_HUMAN';
INSERT INTO "bot_apod_human_tasks" (id,"expedienteId","dedupeKey",kind,reason,evidence)
 SELECT md5('document-review:'||id)::uuid::text,id,'DOCUMENT_REVIEW:'||id||':'||"documentId",'DOCUMENT_REVIEW','Revisar el PDF pendiente antes de incorporarlo a Kmaleon.',jsonb_build_object('ref',"documentId") FROM "bot_apod_expedientes" WHERE "currentState"='AUDITING_DOCUMENT' AND "documentId" IS NOT NULL;
