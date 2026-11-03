const {
  getVitalAlertRepeatMinutes,
  shouldRepeatVitalAlert,
} = require('../lib/vitalAlertCadence');

describe('critical vital alert push cadence', () => {
  const now = new Date('2026-11-03T12:00:00.000Z');

  test('defaults emergency reminders to every four hours', () => {
    expect(getVitalAlertRepeatMinutes('critical', {})).toBe(240);
  });

  test('keeps configured critical reminders within the 3–5 hour window', () => {
    expect(getVitalAlertRepeatMinutes('critical', { CRITICAL_VITAL_REPEAT_MINUTES: '180' })).toBe(180);
    expect(getVitalAlertRepeatMinutes('critical', { CRITICAL_VITAL_REPEAT_MINUTES: '300' })).toBe(300);
    expect(getVitalAlertRepeatMinutes('critical', { CRITICAL_VITAL_REPEAT_MINUTES: '10' })).toBe(180);
    expect(getVitalAlertRepeatMinutes('critical', { CRITICAL_VITAL_REPEAT_MINUTES: '600' })).toBe(300);
  });

  test('does not repeat before four hours, then becomes eligible', () => {
    const lastSentAt = new Date(now.getTime() - 239 * 60 * 1000);
    expect(shouldRepeatVitalAlert(lastSentAt, 240, now)).toBe(false);
    expect(shouldRepeatVitalAlert(new Date(now.getTime() - 240 * 60 * 1000), 240, now)).toBe(true);
  });

  test('does not change the warning repeat cadence', () => {
    expect(getVitalAlertRepeatMinutes('warning', {})).toBe(30);
    expect(getVitalAlertRepeatMinutes('warning', { WARNING_VITAL_REPEAT_MINUTES: '60' })).toBe(60);
  });
});