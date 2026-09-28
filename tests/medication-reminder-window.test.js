const ReminderNotificationScheduler = require('../services/ReminderNotificationScheduler');

describe('Medication reminder due-window checks', () => {
  test('treats a dose as due within 5 minutes in UTC', () => {
    const now = new Date('2026-09-27T19:07:07.697Z');

    expect(ReminderNotificationScheduler.isWithinWindow('19:10', now, 5, 'UTC')).toBe(true);
  });

  test('falls back to UTC when timezone is blank or invalid', () => {
    const now = new Date('2026-09-27T19:07:07.697Z');

    expect(ReminderNotificationScheduler.isWithinWindow('19:10', now, 5, '   ')).toBe(true);
    expect(ReminderNotificationScheduler.isWithinWindow('19:10', now, 5, 'Not/AZone')).toBe(true);
  });
});
