const Medication = require('../models/UserMedication');
const HealthGoal = require('../models/HealthGoal');
const Profile = require('../models/Profile');
const User = require('../models/User');
const NotificationToken = require('../models/NotificationToken');
const ReminderDispatch = require('../models/ReminderDispatch');
const HabitReminderDispatch = require('../models/HabitReminderDispatch');
const sendEmail = require('../utils/email');
const { sendPushToToken } = require('../utils/pushService');

const buildNotExpiredFilter = (now = new Date()) => ({
  $or: [
    { endDate: { $exists: false } },
    { endDate: null },
    { endDate: { $gt: now } },
  ],
});



const formatDateKeyInTimezone = (date, timezone) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
};

const formatTimeKeyInTimezone = (date, timezone) => {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const hour = parts.find((p) => p.type === 'hour')?.value;
  const minute = parts.find((p) => p.type === 'minute')?.value;
  return `${hour}:${minute}`;
};

const getTimezoneWeekdayShort = (date, timezone) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });

  return formatter.format(date);
};

const SHORT_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const timeKeyToMinutes = (timeKey) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(timeKey || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

const medicationTimeToMinutes = (timeKey) => {
  const value = String(timeKey || '').trim().toUpperCase();
  const match = /^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/.exec(value);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3];
  if (minutes > 59 || hours > (meridiem ? 12 : 23) || (meridiem && hours === 0)) return null;
  if (meridiem === 'AM' && hours === 12) hours = 0;
  if (meridiem === 'PM' && hours !== 12) hours += 12;
  return hours * 60 + minutes;
};

const minutesToTimeKey = (minutes) => {
  const normalized = ((minutes % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

const isWithinReminderWindow = (scheduledTimeKey, currentTimeKey, windowMinutes = 1) => {
  const scheduled = timeKeyToMinutes(scheduledTimeKey);
  const current = timeKeyToMinutes(currentTimeKey);
  if (scheduled === null || current === null) return false;

  const directDelta = Math.abs(scheduled - current);
  const wrappedDelta = (24 * 60) - directDelta;
  return Math.min(directDelta, wrappedDelta) <= Math.max(0, Number(windowMinutes) || 0);
};

const intervalToMinutes = (interval) => {
  const lookup = {
    '30 mins': 30,
    '1 hour': 60,
    '2 hours': 120,
    '3 hours': 180,
    '4 hours': 240,
  };
  return lookup[interval] || null;
};

const isTodayAllowed = (repeat, customDays, now = new Date()) => {
  const dayName = SHORT_DAY_NAMES[now.getDay()];
  if (repeat === 'Weekdays') return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(dayName);
  if (repeat === 'Weekends') return ['Sat', 'Sun'].includes(dayName);
  if (repeat === 'Custom') return Array.isArray(customDays) && customDays.includes(dayName);
  return true;
};

const isTodayAllowedInTimezone = (repeat, customDays, now = new Date(), timezone = 'UTC') => {
  const dayName = getTimezoneWeekdayShort(now, timezone);
  if (repeat === 'Weekdays') return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(dayName);
  if (repeat === 'Weekends') return ['Sat', 'Sun'].includes(dayName);
  if (repeat === 'Custom') return Array.isArray(customDays) && customDays.includes(dayName);
  return true;
};

const isValidTimezone = (timezone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const normalizeReminderTimes = (timeList = []) =>
  [...new Set(timeList.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));

const buildWaterReminderTimes = (settings = {}) => {
  const intervalMinutes = intervalToMinutes(settings.interval);
  const startMinutes = timeKeyToMinutes(settings.startTime || settings.time || '09:00');
  const endMinutes = timeKeyToMinutes(settings.endTime || '21:00');

  if (!intervalMinutes || startMinutes === null || endMinutes === null) {
    return [settings.time || settings.startTime || '09:00'].filter(Boolean);
  }

  const times = [];
  for (let minutes = startMinutes; minutes <= endMinutes; minutes += intervalMinutes) {
    times.push(minutesToTimeKey(minutes));
  }
  return times;
};

const buildHabitReminderEntries = (habitKey, settings = {}) => {
  const repeat = settings.repeat || 'Daily';
  const customDays = Array.isArray(settings.customDays) ? settings.customDays : [];

  if (!settings || settings.enabled === false) return [];

  if (habitKey === 'sleep') {
    return normalizeReminderTimes([
      settings.sleepReminderEnabled === false ? null : settings.sleepTime || '22:00',
      settings.wakeReminderEnabled === false ? null : settings.wakeTime || '06:30',
    ]).map((time) => ({
      reminderKey: time === (settings.wakeTime || '06:30') ? 'wake-now' : 'sleep-now',
      label: time === (settings.wakeTime || '06:30') ? 'Wake Now' : 'Sleep Now',
      time,
    }));
  }

  if (habitKey === 'water') {
    return buildWaterReminderTimes(settings).map((time) => ({
      reminderKey: `water-${time}`,
      label: 'Drink Water',
      time,
    }));
  }

  if (habitKey === 'medication' && Array.isArray(settings.slots) && settings.slots.length) {
    return normalizeReminderTimes(settings.slots).map((time) => ({
      reminderKey: `slot-${time}`,
      label: 'Medication',
      time,
    }));
  }

  const baseTime = settings.time || settings.startTime || null;
  return baseTime ? [{ reminderKey: `time-${baseTime}`, label: 'Reminder', time: baseTime }] : [];
};

const buildHabitReminderMessage = (habitTitle, reminderLabel, timeKey) => {
  if (reminderLabel === 'Sleep Now') {
    return {
      title: 'Sleep Reminder',
      body: `It is time to sleep now. ${habitTitle} is due at ${timeKey}.`,
    };
  }

  if (reminderLabel === 'Wake Now') {
    return {
      title: 'Wake Reminder',
      body: `It is time to wake up now. ${habitTitle} is due at ${timeKey}.`,
    };
  }

  if (habitTitle === 'Drink Water') {
    return {
      title: 'Hydration Reminder',
      body: `Drink water now. Your next habit reminder is due at ${timeKey}.`,
    };
  }

  if (habitTitle === 'Exercise') {
    return {
      title: 'Exercise Reminder',
      body: `Time to move. Your exercise reminder is due at ${timeKey}.`,
    };
  }

  return {
    title: `Habit Reminder: ${habitTitle}`,
    body: `${habitTitle} is due now (${timeKey}).`,
  };
};

const humanizeHabitKey = (habitKey) =>
  String(habitKey || '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (char) => char.toUpperCase())
    .trim() || 'Habit';

class ReminderNotificationScheduler {
  constructor() {
    this.interval = null;
    this.isRunning = false;
    this.lastRun = null;
    this.stats = {
      runs: 0,
      pushSent: 0,
      emailSent: 0,
      pushFailed: 0,
      emailFailed: 0,
      skipped: 0,
    };
  }

  getDateKey(now) {
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  isDoseTakenToday(dose, now) {
    if (!dose?.taken || !dose?.takenAt) return false;
    return new Date(dose.takenAt).toDateString() === now.toDateString();
  }

  isDoseSkippedToday(dose, now) {
    if (!dose?.skippedAt) return false;
    return new Date(dose.skippedAt).toDateString() === now.toDateString();
  }

  isDoseTakenTodayInTimezone(dose, now, timezone) {
    if (!dose?.taken || !dose?.takenAt) return false;
    return formatDateKeyInTimezone(new Date(dose.takenAt), timezone) === formatDateKeyInTimezone(now, timezone);
  }

  isDoseSkippedTodayInTimezone(dose, now, timezone) {
    if (!dose?.skippedAt) return false;
    return formatDateKeyInTimezone(new Date(dose.skippedAt), timezone) === formatDateKeyInTimezone(now, timezone);
  }

  getDoseReminderTime(dose, now) {
    const snoozedUntil = dose?.snoozedUntil ? new Date(dose.snoozedUntil) : null;
    if (snoozedUntil && !Number.isNaN(snoozedUntil.getTime()) && snoozedUntil.toDateString() === now.toDateString()) {
      return `${String(snoozedUntil.getHours()).padStart(2, '0')}:${String(snoozedUntil.getMinutes()).padStart(2, '0')}`;
    }

    return String(dose?.time || '');
  }

  isWithinWindow(scheduledTime, now, windowMinutes = 5, timezone = 'UTC') {
    const scheduledMinutes = medicationTimeToMinutes(scheduledTime);
    const currentTime = formatTimeKeyInTimezone(now, timezone);
    const currentMinutes = timeKeyToMinutes(currentTime);
    if (scheduledMinutes === null || currentMinutes === null) return false;

    const difference = Math.abs(scheduledMinutes - currentMinutes);
    const wrappedDifference = (24 * 60) - difference;
    return Math.min(difference, wrappedDifference) <= windowMinutes;
  }

  async alreadyDispatched({ userId, medicationId, reminderDate, reminderTime, channel }) {
    const found = await ReminderDispatch.findOne({
      user: userId,
      medication: medicationId,
      reminderDate,
      reminderTime,
      channel,
    }).lean();

    return Boolean(found?.success);
  }

  async alreadyDispatchedHabit({ userId, habitKey, reminderKey, reminderDate, reminderTime, channel }) {
    const found = await HabitReminderDispatch.findOne({
      user: userId,
      habitKey,
      reminderKey,
      reminderDate,
      reminderTime,
      channel,
    }).lean();

    return Boolean(found);
  }

  async recordDispatch({ userId, medicationId, reminderDate, reminderTime, channel, success, reason = '' }) {
    try {
      await ReminderDispatch.create({
        user: userId,
        medication: medicationId,
        reminderDate,
        reminderTime,
        channel,
        success,
        reason,
      });
    } catch (err) {
      if (err?.code !== 11000) {
        console.error('Reminder dispatch log error:', err.message || err);
      }
    }
  }

  async recordHabitDispatch({ userId, habitKey, reminderKey, reminderDate, reminderTime, success, reason = '' }) {
    try {
      await HabitReminderDispatch.create({
        user: userId,
        habitKey,
        reminderKey,
        reminderDate,
        reminderTime,
        channel: 'push',
        success,
        reason,
      });
    } catch (err) {
      if (err?.code !== 11000) {
        console.error('Habit reminder dispatch log error:', err.message || err);
      }
    }
  }

  async processHabitTrackerReminders() {
    const now = new Date();
    const dateKeyCache = new Map();
    const timeKeyCache = new Map();

    const goals = await HealthGoal.find({ 'habitTracker.reminderSettings': { $exists: true } }).lean();
    if (!goals.length) return;

    for (const goal of goals) {
      const reminderSettings = goal?.habitTracker?.reminderSettings || {};
      const timezone = isValidTimezone(goal?.habitTracker?.timezone) ? goal.habitTracker.timezone : 'UTC';
      const dateKey = dateKeyCache.get(timezone) || formatDateKeyInTimezone(now, timezone);
      const currentTime = timeKeyCache.get(timezone) || formatTimeKeyInTimezone(now, timezone);
      dateKeyCache.set(timezone, dateKey);
      timeKeyCache.set(timezone, currentTime);
      const selectedHabits = Array.isArray(goal?.habitTracker?.selectedHabits) && goal.habitTracker.selectedHabits.length
        ? goal.habitTracker.selectedHabits
        : Object.keys(reminderSettings);

      const profile = await Profile.findOne({ user: goal.user }).lean();
      const notifications = profile?.notifications || {};

      if (notifications.reminders === false || notifications.push === false) {
        this.stats.skipped += 1;
        continue;
      }

      const tokenDoc = await NotificationToken.findOne({ userId: goal.user }).lean();
      if (!tokenDoc?.token) {
        this.stats.skipped += 1;
        continue;
      }

      for (const habitKey of selectedHabits) {
        const settings = reminderSettings[habitKey] || {};
        if (!isTodayAllowedInTimezone(settings.repeat || 'Daily', settings.customDays, now, timezone)) continue;

        const habitTitle = humanizeHabitKey(habitKey);

        const entries = buildHabitReminderEntries(habitKey, settings)
          .filter((item) => isWithinReminderWindow(item.time, currentTime, 1));

        for (const entry of entries) {
          const alreadyPush = await this.alreadyDispatchedHabit({
            userId: goal.user,
            habitKey,
            reminderKey: entry.reminderKey,
            reminderDate: dateKey,
            reminderTime: entry.time,
            channel: 'push',
          });

          if (alreadyPush) continue;

          const message = buildHabitReminderMessage(habitTitle, entry.label, entry.time);
          const pushResult = await sendPushToToken(tokenDoc.token, message.title, message.body, {
            type: 'habit_reminder',
            habitKey,
            reminderKey: entry.reminderKey,
            reminderLabel: entry.label,
            dueTime: entry.time,
            route: '/health-tips',
          });

          await this.recordHabitDispatch({
            userId: goal.user,
            habitKey,
            reminderKey: entry.reminderKey,
            reminderDate: dateKey,
            reminderTime: entry.time,
            success: Boolean(pushResult.success),
            reason: pushResult.reason || '',
          });

          if (pushResult.success) this.stats.pushSent += 1;
          else this.stats.pushFailed += 1;
        }
      }
    }
  }

async processDueReminders() {
  const now = new Date();

  const medications = await Medication.find({
    isActive: true,
    isCompleted: false,
  }).lean();


  if (!medications.length) {
     console.log("meds found for reporting")
    return;
   
  }

 for (const medication of medications) {
  console.log("meds found for reporting", medication);
  try {
    const user = await User.findById(medication.user).select("email timezone").lean();
    const timezone = isValidTimezone(medication.timezone)
      ? medication.timezone
      : isValidTimezone(user?.timezone)
        ? user.timezone
        : "UTC";

    await this.processMedicationReminder(medication, now, timezone);
  } catch (error) {
    console.error(
      `[Medication Reminder] Failed for ${medication._id}:`,
      error
    );
  }
}
}

/**
 * Process reminders for a single medication.
 */
async processMedicationReminder(medication, now, timezone = "UTC") {
  const {
    _id,
    user,
    medicineName,
    dosages = [],
    durationEndDate,
    isActive,
    isCompleted,
  } = medication;

  if (!isActive || isCompleted) {
    console.log(`[Medication Reminder] Skipping ${_id} (inactive/completed)`);
    return;
  }

  if (durationEndDate && now > new Date(durationEndDate)) {
    console.log(`[Medication Reminder] Skipping ${_id} (duration ended)`);
    return;
  }

  const WINDOW_MINUTES = 5;

  const dueDosages = dosages.filter((dose) => {
    if (dose.taken || this.isDoseSkippedTodayInTimezone(dose, now, timezone)) return false;
    if (dose.snoozedUntil && new Date(dose.snoozedUntil) > now) return false;
    return this.isWithinWindow(dose.time, now, WINDOW_MINUTES, timezone);
  });

  if (!dueDosages.length) {
    console.log(`[Medication Reminder] No dosage due right now for ${_id}`);
    return;
  }

  const userDoc = await User.findById(user).select('email timezone').lean();
  const profile = await Profile.findOne({ user }).select('notifications').lean();
  const tokenDoc = await NotificationToken.findOne({ userId: user }).lean();
  const notifications = profile?.notifications || {};
  const dateKey = formatDateKeyInTimezone(now, timezone);
  const timeKey = formatTimeKeyInTimezone(now, timezone);

  for (const dose of dueDosages) {
    console.log(
      `[Medication Reminder] Dosage due for ${medicineName} (user ${user}) at ${dose.time}`
    );

    await this.processDoseReminder({
      medication,
      dose,
      user: userDoc,
      tokenDoc,
      notifications,
      userId: user,
      dateKey,
      timeKey: dose.time || timeKey,
    });
  }
}
/**
 * Process push and email reminders for a single dose.
 */
async processDoseReminder({
  medication,
  dose,
  user,
  tokenDoc,
  notifications,
  userId,
  dateKey,
  timeKey,
}) {
  /*
   * Don't remind the user if the dose has already been taken.
   */
  if (dose.taken) {
    return;
  }

  /*
   * Don't remind the user if the dose was skipped.
   */
  if (dose.skippedAt) {
    return;
  }

  const title = `Medication Reminder: ${medication.medicineName}`;

  const body = this.buildMedicationNotificationBody(
    medication,
    dose
  );

  /*
   * Send push notification.
   */
  if (notifications.push !== false) {
    await this.sendMedicationPushReminder({
      medication,
      dose,
      tokenDoc,
      title,
      body,
      userId,
      dateKey,
      timeKey,
    });
  }

  /*
   * Send email notification.
   */
  if (notifications.email === true && user?.email) {
    await this.sendMedicationEmailReminder({
      medication,
      dose,
      user,
      userId,
      dateKey,
      timeKey,
    });
  }
}

/**
 * Build push notification body.
 */
buildMedicationNotificationBody(medication, dose) {
  const details = [
    medication.strength,
    medication.frequency,
  ].filter(Boolean);

  const medicationDetails = details.length
    ? `${details.join(' • ')} • `
    : '';

  return `${medicationDetails}Due now (${dose.time})`;
}

/**
 * Send medication push notification.
 */
async sendMedicationPushReminder({
  medication,
  dose,
  tokenDoc,
  title,
  body,
  userId,
  dateKey,
  timeKey,
}) {
  const alreadyPush = await this.alreadyDispatched({
    userId,
    medicationId: medication._id,
    reminderDate: dateKey,
    reminderTime: timeKey,
    channel: 'push',
  });

  if (alreadyPush) {
    return;
  }

  const pushResult = await sendPushToToken(
    tokenDoc?.token,
    title,
    body,
    {
      type: 'medication_reminder',
      medicationId: String(medication._id),
      dueTime: dose.time,
      route: '/health/medications',
    }
  );

  await this.recordDispatch({
    userId,
    medicationId: medication._id,
    reminderDate: dateKey,
    reminderTime: timeKey,
    channel: 'push',
    success: Boolean(pushResult.success),
    reason: pushResult.reason || '',
  });

  if (pushResult.success) {
    this.stats.pushSent += 1;
  } else {
    this.stats.pushFailed += 1;
  }
}

/**
 * Send medication email reminder.
 */
async sendMedicationEmailReminder({
  medication,
  dose,
  user,
  userId,
  dateKey,
  timeKey,
}) {
  const alreadyEmail = await this.alreadyDispatched({
    userId,
    medicationId: medication._id,
    reminderDate: dateKey,
    reminderTime: timeKey,
    channel: 'email',
  });

  if (alreadyEmail) {
    return;
  }

  const subject = `Qureo Reminder: ${medication.medicineName}`;

  const textMessage = `
It's time to take ${medication.medicineName}
(${medication.strength || ''}).

Scheduled time: ${dose.time}
  `.trim();

  const htmlMessage = `
    <p>
      It is time to take
      <strong>${medication.medicineName}</strong>
      (${medication.strength || ''}).
    </p>

    <p>
      Scheduled time:
      <strong>${dose.time}</strong>
    </p>

    ${
      medication.instructions
        ? `
          <p>
            Instructions:
            <strong>${medication.instructions}</strong>
          </p>
        `
        : ''
    }
  `;

  const sent = await sendEmail(
    user.email,
    subject,
    textMessage,
    htmlMessage
  );

  await this.recordDispatch({
    userId,
    medicationId: medication._id,
    reminderDate: dateKey,
    reminderTime: timeKey,
    channel: 'email',
    success: Boolean(sent),
    reason: sent ? '' : 'Email send failed',
  });

  if (sent) {
    this.stats.emailSent += 1;
  } else {
    this.stats.emailFailed += 1;
  }
}

  async runTick() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      this.lastRun = new Date();
      this.stats.runs += 1;
      await this.processDueReminders();
      await this.processHabitTrackerReminders();
    } catch (err) {
      console.error('ReminderNotificationScheduler tick error:', err);
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    if (this.interval) return;
    console.log('⏰ Starting Reminder Notification Scheduler...');
    this.runTick();
    this.interval = setInterval(() => this.runTick(), 60 * 1000);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('🛑 Reminder Notification Scheduler stopped');
    }
  }

  getStatus() {
    return {
      running: Boolean(this.interval),
      isProcessing: this.isRunning,
      lastRun: this.lastRun,
      stats: this.stats,
    };
  }
}

module.exports = new ReminderNotificationScheduler();
