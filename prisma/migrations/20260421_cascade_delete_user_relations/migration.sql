-- Add ON DELETE CASCADE to user relations that were missing it

-- ScheduleConfig
ALTER TABLE "ScheduleConfig" DROP CONSTRAINT "ScheduleConfig_userId_fkey";
ALTER TABLE "ScheduleConfig" ADD CONSTRAINT "ScheduleConfig_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CalendarBlock
ALTER TABLE "CalendarBlock" DROP CONSTRAINT "CalendarBlock_userId_fkey";
ALTER TABLE "CalendarBlock" ADD CONSTRAINT "CalendarBlock_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Notification
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_userId_fkey";
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AvailabilityOverride
ALTER TABLE "AvailabilityOverride" DROP CONSTRAINT "AvailabilityOverride_userId_fkey";
ALTER TABLE "AvailabilityOverride" ADD CONSTRAINT "AvailabilityOverride_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- EventFreeOverride
ALTER TABLE "EventFreeOverride" DROP CONSTRAINT "EventFreeOverride_userId_fkey";
ALTER TABLE "EventFreeOverride" ADD CONSTRAINT "EventFreeOverride_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CalendarConnection
ALTER TABLE "CalendarConnection" DROP CONSTRAINT "CalendarConnection_userId_fkey";
ALTER TABLE "CalendarConnection" ADD CONSTRAINT "CalendarConnection_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AvailabilitySlot (child of ScheduleConfig)
ALTER TABLE "AvailabilitySlot" DROP CONSTRAINT "AvailabilitySlot_scheduleConfigId_fkey";
ALTER TABLE "AvailabilitySlot" ADD CONSTRAINT "AvailabilitySlot_scheduleConfigId_fkey"
  FOREIGN KEY ("scheduleConfigId") REFERENCES "ScheduleConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
