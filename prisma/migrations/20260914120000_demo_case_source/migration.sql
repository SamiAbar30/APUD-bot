-- Mark the provenance of local cases so synthetic demo records cannot be mistaken for client data.
ALTER TABLE "bot_apod_expedientes" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'OPERATOR';
