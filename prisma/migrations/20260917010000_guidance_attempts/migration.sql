ALTER TABLE "bot_apod_expedientes"
  ADD COLUMN "digitalHelpAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "certificateHelpAttempts" INTEGER NOT NULL DEFAULT 0;
