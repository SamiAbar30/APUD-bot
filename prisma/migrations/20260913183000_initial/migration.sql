-- CreateEnum
CREATE TYPE "ApodState" AS ENUM ('INITIAL_TRIAGE', 'WAITING_CERT_RESPONSE', 'MOBILE_TRIAGE_PC_CHECK', 'MOBILE_EXPORT_GUIDE_SENT', 'MOBILE_ASSIST_CONSENT_REQUESTED', 'MOBILE_ASSIST_PROCESSING', 'PC_TUTORIAL_SENT', 'WAITING_PDF_SUBMISSION', 'AUDITING_DOCUMENT', 'PROVISIONAL_VIABILIZED', 'REVOCATION_GUIDE_SENT', 'WAITING_REVOCATION_REISSUE', 'CERT_ACQUISITION_LINKS_SENT', 'COURT_FALLBACK_GUIDE_SENT', 'APUDATA_PENDING_PREAPPROVAL', 'APUDATA_WAITING_PAYMENT', 'APUDATA_VIDEO_IN_PROGRESS', 'KMALEON_FILING', 'HANDOFF_CARMEN', 'COMPLETED', 'ESCALATED_HUMAN');

-- CreateTable
CREATE TABLE "bot_apod_expedientes" (
    "id" TEXT NOT NULL,
    "dni" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "telefono" TEXT NOT NULL,
    "kmaleonExpedienteId" TEXT,
    "identityVerified" BOOLEAN NOT NULL DEFAULT false,
    "currentState" "ApodState" NOT NULL DEFAULT 'INITIAL_TRIAGE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "hasDigitalCert" BOOLEAN,
    "certDevice" TEXT,
    "consentGranted" BOOLEAN NOT NULL DEFAULT false,
    "consentVersion" TEXT,
    "consentGrantedAt" TIMESTAMP(3),
    "auditStatus" TEXT,
    "pageCount" INTEGER,
    "isProvisionalFiled" BOOLEAN NOT NULL DEFAULT false,
    "apudataOrderId" TEXT,
    "apudataPreApproved" BOOLEAN NOT NULL DEFAULT false,
    "apudataApprovalExpiresAt" TIMESTAMP(3),
    "apudataApprovalEvidence" JSONB,
    "documentId" TEXT,
    "documentApproved" BOOLEAN NOT NULL DEFAULT false,
    "clientReviewed" BOOLEAN NOT NULL DEFAULT false,
    "lastInboundAt" TIMESTAMP(3),
    "direccion" TEXT,
    "codigoPostal" TEXT,
    "provincia" TEXT,
    "localidad" TEXT,
    "comunidadAutonoma" TEXT,
    "partidoJudicial" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_apod_expedientes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_apod_acciones" (
    "id" TEXT NOT NULL,
    "expedienteId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "expectedVersion" INTEGER NOT NULL,
    "actionType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT,
    "receipt" JSONB,
    "executedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_apod_acciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_apod_documentos" (
    "id" TEXT NOT NULL,
    "expedienteId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "s3OrLocalPath" TEXT NOT NULL,
    "sha256Hash" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "hasAiram" BOOLEAN NOT NULL DEFAULT false,
    "hasPowersArt25" BOOLEAN NOT NULL DEFAULT false,
    "identityMatches" BOOLEAN NOT NULL DEFAULT false,
    "rawAuditJson" JSONB NOT NULL,
    "uploadedKmaleon" BOOLEAN NOT NULL DEFAULT false,
    "kmaleonDocumentId" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "clientReviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_apod_documentos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_apod_audit_logs" (
    "id" TEXT NOT NULL,
    "expedienteId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "fromState" "ApodState",
    "toState" "ApodState",
    "metadata" JSONB,
    "operator" TEXT NOT NULL DEFAULT 'SYSTEM_BOT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_apod_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_apod_inbox" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "expedienteId" TEXT,
    "telefono" TEXT,
    "source" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notBefore" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "bot_apod_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_apod_expedientes_dni_key" ON "bot_apod_expedientes"("dni");

-- CreateIndex
CREATE UNIQUE INDEX "bot_apod_expedientes_telefono_key" ON "bot_apod_expedientes"("telefono");

-- CreateIndex
CREATE UNIQUE INDEX "bot_apod_expedientes_apudataOrderId_key" ON "bot_apod_expedientes"("apudataOrderId");

-- CreateIndex
CREATE INDEX "bot_apod_expedientes_kmaleonExpedienteId_idx" ON "bot_apod_expedientes"("kmaleonExpedienteId");

-- CreateIndex
CREATE INDEX "bot_apod_expedientes_currentState_updatedAt_idx" ON "bot_apod_expedientes"("currentState", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "bot_apod_acciones_decisionId_key" ON "bot_apod_acciones"("decisionId");

-- CreateIndex
CREATE UNIQUE INDEX "bot_apod_acciones_idempotencyKey_key" ON "bot_apod_acciones"("idempotencyKey");

-- CreateIndex
CREATE INDEX "bot_apod_acciones_status_createdAt_idx" ON "bot_apod_acciones"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "bot_apod_documentos_expedienteId_sha256Hash_key" ON "bot_apod_documentos"("expedienteId", "sha256Hash");

-- CreateIndex
CREATE INDEX "bot_apod_audit_logs_expedienteId_createdAt_idx" ON "bot_apod_audit_logs"("expedienteId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "bot_apod_inbox_externalId_key" ON "bot_apod_inbox"("externalId");

-- CreateIndex
CREATE INDEX "bot_apod_inbox_status_notBefore_idx" ON "bot_apod_inbox"("status", "notBefore");

-- AddForeignKey
ALTER TABLE "bot_apod_acciones" ADD CONSTRAINT "bot_apod_acciones_expedienteId_fkey" FOREIGN KEY ("expedienteId") REFERENCES "bot_apod_expedientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_apod_documentos" ADD CONSTRAINT "bot_apod_documentos_expedienteId_fkey" FOREIGN KEY ("expedienteId") REFERENCES "bot_apod_expedientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_apod_audit_logs" ADD CONSTRAINT "bot_apod_audit_logs_expedienteId_fkey" FOREIGN KEY ("expedienteId") REFERENCES "bot_apod_expedientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_apod_inbox" ADD CONSTRAINT "bot_apod_inbox_expedienteId_fkey" FOREIGN KEY ("expedienteId") REFERENCES "bot_apod_expedientes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

