-- Existing conversations share the same first-contact anchor as new APUD v1 cases.
-- Keep already-sent reminder days so migration cannot cause duplicate reminders.
UPDATE "bot_apod_expedientes"
SET "reminderAnchorAt" = "phaseOneStartedAt",
    "nextReminderAt" = CASE
      WHEN "automationPaused" OR "optOutAt" IS NOT NULL OR "phaseOneClosedAt" IS NOT NULL THEN NULL
      WHEN "lastReminderDay" < 3 THEN "phaseOneStartedAt" + INTERVAL '3 days'
      WHEN "lastReminderDay" < 7 THEN "phaseOneStartedAt" + INTERVAL '7 days'
      WHEN "lastReminderDay" < 15 THEN "phaseOneStartedAt" + INTERVAL '15 days'
      WHEN "lastReminderDay" < 30 THEN "phaseOneStartedAt" + INTERVAL '30 days'
      ELSE NULL
    END
WHERE "phaseOneStartedAt" IS NOT NULL;
