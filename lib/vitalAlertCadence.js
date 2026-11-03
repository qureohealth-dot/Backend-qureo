const CRITICAL_REPEAT_MIN_MINUTES = 180;
const CRITICAL_REPEAT_MAX_MINUTES = 300;
const CRITICAL_REPEAT_DEFAULT_MINUTES = 240;
const WARNING_REPEAT_DEFAULT_MINUTES = 30;

function getVitalAlertRepeatMinutes(severity, env = process.env) {
  if (severity !== 'critical') {
    const configuredWarning = Number(env.WARNING_VITAL_REPEAT_MINUTES);
    return Number.isFinite(configuredWarning) && configuredWarning >= 10
      ? configuredWarning
      : WARNING_REPEAT_DEFAULT_MINUTES;
  }

  const configuredCritical = Number(env.CRITICAL_VITAL_REPEAT_MINUTES);
  const requestedMinutes = Number.isFinite(configuredCritical) && configuredCritical > 0
    ? configuredCritical
    : CRITICAL_REPEAT_DEFAULT_MINUTES;

  return Math.min(CRITICAL_REPEAT_MAX_MINUTES, Math.max(CRITICAL_REPEAT_MIN_MINUTES, requestedMinutes));
}

function shouldRepeatVitalAlert(previousCreatedAt, intervalMinutes, now = new Date()) {
  if (!previousCreatedAt) return true;
  const previousTime = new Date(previousCreatedAt).getTime();
  if (!Number.isFinite(previousTime)) return true;
  return now.getTime() - previousTime >= intervalMinutes * 60 * 1000;
}

module.exports = { getVitalAlertRepeatMinutes, shouldRepeatVitalAlert };