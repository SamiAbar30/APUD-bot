-- Conversational memory: the exact pending question and a durable redacted summary,
-- so a client returning after days is answered in context instead of being re-asked.
ALTER TABLE "bot_apod_expedientes"
  ADD COLUMN "pendingQuestion" TEXT,
  ADD COLUMN "pendingQuestionAt" TIMESTAMP(3),
  ADD COLUMN "conversationSummary" TEXT,
  ADD COLUMN "conversationSummaryAt" TIMESTAMP(3),
  ADD COLUMN "conversationSummaryTurns" INTEGER NOT NULL DEFAULT 0;
