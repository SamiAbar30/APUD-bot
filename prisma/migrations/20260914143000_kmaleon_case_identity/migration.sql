-- Preserve company and business-facing expediente number returned by Kmaleon.
-- Nullable keeps existing operator/demo rows valid; fresh Kmaleon selections fill both values.
ALTER TABLE "bot_apod_expedientes" ADD COLUMN "empresa" TEXT;
ALTER TABLE "bot_apod_expedientes" ADD COLUMN "numeroExpediente" TEXT;
