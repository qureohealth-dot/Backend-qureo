const express = require('express');
const auth = require('../middleware/auth');
const HealthGoal = require('../models/HealthGoal');
const HabitTrackerEntry = require('../models/HabitTrackerEntry');
const DailyHealthTipService = require('../services/DailyHealthTipService');
const Medication = require('../models/Medication');
const Vitals = require('../models/Vitals');
const HealthAlert = require('../models/HealthAlert');

const router = express.Router();

const HABIT_DEFINITIONS = {
  water: { key: 'water', title: 'Drink Water', target: 8, unit: 'glasses' },
  exercise: { key: 'exercise', title: 'Exercise', target: 60, unit: 'mins' },
  medication: { key: 'medication', title: 'Medication', target: 3, unit: 'doses' },
  sleep: { key: 'sleep', title: 'Sleep', target: 8, unit: 'hours' },
  walking: { key: 'walking', title: 'Walking', target: 10000, unit: 'steps' },
  bloodPressure: { key: 'bloodPressure', title: 'Blood Pressure', target: 1, unit: 'checks' },
  bloodSugar: { key: 'bloodSugar', title: 'Blood Sugar', target: 1, unit: 'checks' },
  weight: { key: 'weight', title: 'Weight', target: 1, unit: 'entry' },
  healthyMeals: { key: 'healthyMeals', title: 'Healthy Meals', target: 3, unit: 'meals' },
  meditation: { key: 'meditation', title: 'Meditation', target: 20, unit: 'mins' },
  vitamins: { key: 'vitamins', title: 'Vitamins', target: 1, unit: 'dose' },
  heartRate: { key: 'heartRate', title: 'Heart Rate', target: 1, unit: 'check' },
  mood: { key: 'mood', title: 'Mood', target: 1, unit: 'check-in' },
  stretching: { key: 'stretching', title: 'Stretching', target: 20, unit: 'mins' },
};

const DEFAULT_SELECTED_HABITS = ['water', 'exercise', 'medication', 'sleep', 'walking', 'mood'];

const SCORE_WEIGHTS = {
  water: 20,
  exercise: 25,
  medication: 25,
  sleep: 15,
  walking: 10,
  mood: 5,
};

const MOTIVATIONAL_TEMPLATES = {
  water: 'Your body needs hydration. Drink a glass of water now.',
  exercise: 'You are one workout away from a healthier you.',
  medication: 'Your health comes first. It is time for your medication.',
  walking: 'A short walk right now can make a big difference.',
  sleep: 'Prepare for bedtime and recharge your body.',
  mood: 'How are you feeling today? Take a moment to check in with yourself.',
};

const REPEAT_VALUES = new Set(['Daily', 'Weekdays', 'Weekends', 'Custom']);
const DAY_VALUES = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function toDateKey(date = new Date(), timezone = 'UTC') {
  const safeTimezone = isValidTimezone(timezone) ? timezone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function parseDateKey(input) {
  if (!input || typeof input !== 'string') return new Date();
  const candidate = new Date(`${input}T00:00:00`);
  return Number.isNaN(candidate.getTime()) ? new Date() : candidate;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (Number.isNaN(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function getTrackerTimezone(goal) {
  const timezone = goal?.habitTracker?.timezone;
  return typeof timezone === 'string' && isValidTimezone(timezone) ? timezone : 'UTC';
}

function listDateKeys(startKey, endKey) {
  const [startYear, startMonth, startDay] = String(startKey).split('-').map(Number);
  const [endYear, endMonth, endDay] = String(endKey).split('-').map(Number);
  const current = new Date(Date.UTC(startYear, startMonth - 1, startDay));
  const end = new Date(Date.UTC(endYear, endMonth - 1, endDay));
  const dateKeys = [];

  while (current <= end) {
    dateKeys.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dateKeys;
}

function areConsecutiveDateKeys(previousKey, currentKey) {
  const previous = new Date(`${previousKey}T00:00:00Z`);
  const current = new Date(`${currentKey}T00:00:00Z`);
  return current.getTime() - previous.getTime() === 24 * 60 * 60 * 1000;
}

function normalizeSelectedHabits(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return DEFAULT_SELECTED_HABITS;
  }

  const allowed = new Set(Object.keys(HABIT_DEFINITIONS));
  const deduped = [];
  const seen = new Set();

  input.forEach((item) => {
    if (!allowed.has(item) || seen.has(item)) return;
    seen.add(item);
    deduped.push(item);
  });

  return deduped.length ? deduped : DEFAULT_SELECTED_HABITS;
}

function normalizeReminderSettings(selectedHabits, reminderSettings) {
  const result = {};
  const source = reminderSettings && typeof reminderSettings === 'object' ? reminderSettings : {};
  const isValidTime = (value) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || ''));

  selectedHabits.forEach((habitKey) => {
    const incoming = source[habitKey] && typeof source[habitKey] === 'object' ? source[habitKey] : {};
    const repeat = REPEAT_VALUES.has(incoming.repeat) ? incoming.repeat : 'Daily';
    const customDays = Array.isArray(incoming.customDays)
      ? incoming.customDays.filter((day) => DAY_VALUES.has(day))
      : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    const normalized = {
      enabled: incoming.enabled !== false,
      repeat,
      time: isValidTime(incoming.time) ? incoming.time : '08:00',
      startTime: isValidTime(incoming.startTime) ? incoming.startTime : '08:00',
      endTime: isValidTime(incoming.endTime) ? incoming.endTime : '20:00',
      customDays,
    };

    if (habitKey === 'water') {
      const allowedIntervals = new Set(['30 mins', '1 hour', '2 hours', '3 hours', '4 hours']);
      normalized.interval = allowedIntervals.has(incoming.interval) ? incoming.interval : '1 hour';
    }

    if (habitKey === 'medication') {
      normalized.slots = Array.isArray(incoming.slots)
        ? incoming.slots.filter((value) => isValidTime(value)).slice(0, 5)
        : [];
      if (!normalized.slots.length) {
        normalized.slots = [normalized.time];
      }
    }

    if (habitKey === 'sleep') {
      normalized.sleepReminderEnabled = incoming.sleepReminderEnabled !== false;
      normalized.sleepTime = isValidTime(incoming.sleepTime) ? incoming.sleepTime : '22:00';
      normalized.wakeReminderEnabled = incoming.wakeReminderEnabled !== false;
      normalized.wakeTime = isValidTime(incoming.wakeTime) ? incoming.wakeTime : '06:30';
    }

    result[habitKey] = normalized;
  });

  return result;
}

function getScoreLevel(score) {
  if (score >= 96) return 'Excellent';
  if (score >= 80) return 'Great';
  if (score >= 60) return 'Good';
  return 'Needs Improvement';
}

function ensureHabitState(entry, selectedHabits) {
  const habits = entry.habits && typeof entry.habits === 'object' ? { ...entry.habits } : {};

  selectedHabits.forEach((habitKey) => {
    const def = HABIT_DEFINITIONS[habitKey];
    if (!def) return;

    const current = habits[habitKey] || {};
    const target = Number(current.target || def.target);
    const progress = Number(current.progress || 0);

    habits[habitKey] = {
      key: habitKey,
      title: def.title,
      unit: def.unit,
      target,
      progress,
      completion: target > 0 ? Math.min(100, Math.round((progress / target) * 100)) : 0,
      updatedAt: current.updatedAt || null,
    };
  });

  entry.habits = habits;
  return habits;
}

function computeHealthScore(habits) {
  let score = 0;

  Object.entries(SCORE_WEIGHTS).forEach(([habitKey, weight]) => {
    const state = habits?.[habitKey];
    if (!state) return;
    const target = Number(state.target || 0);
    const progress = Number(state.progress || 0);
    if (target <= 0) return;
    const ratio = Math.min(1, progress / target);
    score += ratio * weight;
  });

  const rounded = Math.round(score);
  return {
    value: rounded,
    level: getScoreLevel(rounded),
    achievedGoal: rounded >= 100,
  };
}

function buildMotivationalMessages(selectedHabits, habits = {}) {
  const messages = [];

  selectedHabits.forEach((habitKey) => {
    if (!MOTIVATIONAL_TEMPLATES[habitKey]) return;
    const state = habits[habitKey] || {};
    const target = Number(state.target || 0);
    const progress = Number(state.progress || 0);
    const completion = target > 0 ? Math.round((progress / target) * 100) : 0;

    if (completion < 100) {
      messages.push({ habitKey, message: MOTIVATIONAL_TEMPLATES[habitKey], completion });
    }
  });

  return messages.slice(0, 5);
}

async function getOrCreateEntry(userId, dateKey, selectedHabits) {
  let entry = await HabitTrackerEntry.findOne({ user: userId, dateKey });
  if (!entry) {
    entry = await HabitTrackerEntry.create({ user: userId, dateKey });
  }
  ensureHabitState(entry, selectedHabits);
  return entry;
}

async function applyHabitLog({ userId, habitKey, value = 1, action = 'log', label, mood, weight }) {
  const now = new Date();
  const goal = await getOrCreateGoal(userId);
  const dateKey = toDateKey(now, getTrackerTimezone(goal));
  const selectedHabits = normalizeSelectedHabits(goal?.habitTracker?.selectedHabits || []);
  const entry = await getOrCreateEntry(userId, dateKey, selectedHabits);

  const habits = entry.habits;
  const habitState = habits[habitKey] || {
    key: habitKey,
    title: HABIT_DEFINITIONS[habitKey].title,
    target: HABIT_DEFINITIONS[habitKey].target,
    progress: 0,
    unit: HABIT_DEFINITIONS[habitKey].unit,
    completion: 0,
  };

  if (habitKey === 'mood' && mood) {
    entry.mood = {
      label: mood.label || mood,
      emoji: mood.emoji || '',
    };
    habitState.progress = 1;
  } else if (habitKey === 'weight' && Number.isFinite(Number(weight))) {
    entry.weight = Number(weight);
    habitState.progress = 1;
  } else if (action === 'set') {
    habitState.progress = Math.max(0, Number(value) || 0);
  } else {
    habitState.progress = Math.max(0, Number(habitState.progress || 0) + (Number(value) || 1));
  }

  habitState.completion = habitState.target > 0
    ? Math.min(100, Math.round((habitState.progress / habitState.target) * 100))
    : 0;
  habitState.updatedAt = now;

  habits[habitKey] = habitState;
  entry.habits = habits;

  entry.timeline = [
    {
      habitKey,
      label: label || `${HABIT_DEFINITIONS[habitKey].title} updated`,
      action,
      value: Number(value) || 1,
      status: 'done',
      timestamp: now,
    },
    ...(Array.isArray(entry.timeline) ? entry.timeline : []),
  ].slice(0, 100);

  const score = computeHealthScore(habits);
  entry.healthScore = score.value;
  entry.achievedGoal = score.achievedGoal;

  await entry.save();
  return { entry, score, selectedHabits };
}

function getRangeStart(range, now = new Date()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);

  if (range === 'today') {
    return date;
  }

  if (range === 'week') {
    date.setDate(date.getDate() - 6);
    return date;
  }

  if (range === 'month') {
    date.setMonth(date.getMonth() - 1);
    date.setDate(date.getDate() + 1);
    return date;
  }

  if (range === 'year') {
    date.setFullYear(date.getFullYear() - 1);
    date.setDate(date.getDate() + 1);
    return date;
  }

  date.setDate(date.getDate() - 6);
  return date;
}

async function getOrCreateGoal(userId) {
  let goal = await HealthGoal.findOne({ user: userId });
  if (!goal) {
    goal = await HealthGoal.create({ user: userId });
  }

  if (!goal.habitTracker) {
    goal.habitTracker = {
      selectedHabits: DEFAULT_SELECTED_HABITS,
      reminderSettings: {},
      updatedAt: new Date(),
    };
    await goal.save();
  }

  return goal;
}

router.get('/config', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const goal = await getOrCreateGoal(userId);

    const selectedHabits = normalizeSelectedHabits(goal?.habitTracker?.selectedHabits || []);
    const reminderSettings = goal?.habitTracker?.reminderSettings || {};
    const timezone = typeof goal?.habitTracker?.timezone === 'string' && goal.habitTracker.timezone.trim()
      ? goal.habitTracker.timezone
      : 'UTC';

    res.json({
      success: true,
      config: {
        selectedHabits,
        reminderSettings,
        timezone,
        primaryGoal: goal.primaryGoal,
        weeklyTarget: goal.weeklyTarget,
        reminderTime: goal.reminderTime,
      },
    });
  } catch (error) {
    console.error('habitTracker/config get error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch habit tracker config' });
  }
});

router.put('/config', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const { selectedHabits, reminderSettings = {}, primaryGoal, weeklyTarget, reminderTime, timezone } = req.body || {};

    const goal = await getOrCreateGoal(userId);
    const normalizedSelectedHabits = normalizeSelectedHabits(selectedHabits || goal?.habitTracker?.selectedHabits);
    const safeTimezone = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : goal?.habitTracker?.timezone || 'UTC';

    const normalizedReminderSettings = normalizeReminderSettings(normalizedSelectedHabits, reminderSettings);

    goal.habitTracker = {
      selectedHabits: normalizedSelectedHabits,
      timezone: safeTimezone,
      reminderSettings: normalizedReminderSettings,
      updatedAt: new Date(),
    };

    if (typeof primaryGoal === 'string') {
      goal.primaryGoal = primaryGoal;
    }

    if (weeklyTarget !== undefined) {
      goal.weeklyTarget = clampNumber(weeklyTarget, 1, 14);
    }

    if (typeof reminderTime === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(reminderTime)) {
      goal.reminderTime = reminderTime;
    }

    await goal.save();

    res.json({
      success: true,
      config: {
        selectedHabits: goal.habitTracker.selectedHabits,
        timezone: goal.habitTracker.timezone,
        reminderSettings: goal.habitTracker.reminderSettings,
        primaryGoal: goal.primaryGoal,
        weeklyTarget: goal.weeklyTarget,
        reminderTime: goal.reminderTime,
      },
      message: 'Habit tracker config saved',
    });
  } catch (error) {
    console.error('habitTracker/config put error:', error);
    res.status(500).json({ success: false, message: 'Failed to save habit tracker config' });
  }
});

router.get('/dashboard', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const goal = await getOrCreateGoal(userId);
    const timezone = getTrackerTimezone(goal);
    const requestedDate = parseDateKey(req.query?.date);
    const dateKey = req.query?.date
      ? toDateKey(requestedDate, 'UTC')
      : toDateKey(new Date(), timezone);
    const selectedHabits = normalizeSelectedHabits(goal?.habitTracker?.selectedHabits || []);

    const entry = await getOrCreateEntry(userId, dateKey, selectedHabits);
    const habits = entry.habits;
    const score = computeHealthScore(habits);

    entry.healthScore = score.value;
    entry.achievedGoal = score.achievedGoal;
    await entry.save();

    const tipResult = await DailyHealthTipService.ensureTodayTipForUser(userId);

    const timeline = Array.isArray(entry.timeline)
      ? [...entry.timeline].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      : [];

    const upcomingReminders = Object.entries(goal?.habitTracker?.reminderSettings || {})
      .flatMap(([habitKey, settings]) => {
        const title = HABIT_DEFINITIONS[habitKey]?.title || habitKey;
        const repeat = settings?.repeat || 'Daily';
        const enabled = settings?.enabled !== false;
        if (!enabled) return [];

        if (habitKey === 'sleep') {
          const items = [];
          if (settings?.sleepReminderEnabled !== false && settings?.sleepTime) {
            items.push({
              habitKey,
              title,
              trigger: 'sleep-now',
              label: 'Sleep Now',
              time: settings.sleepTime,
              repeat,
              enabled,
            });
          }
          if (settings?.wakeReminderEnabled !== false && settings?.wakeTime) {
            items.push({
              habitKey,
              title,
              trigger: 'wake-now',
              label: 'Wake Now',
              time: settings.wakeTime,
              repeat,
              enabled,
            });
          }
          return items;
        }

        if (habitKey === 'medication' && Array.isArray(settings?.slots) && settings.slots.length) {
          return settings.slots.map((slot) => ({
            habitKey,
            title,
            time: slot,
            repeat,
            enabled,
          }));
        }

        return [{
          habitKey,
          title,
          time: settings?.time || settings?.startTime || null,
          repeat,
          enabled,
          interval: habitKey === 'water' ? settings?.interval || null : null,
        }];
      })
      .filter((item) => item.enabled && item.time)
      .sort((a, b) => String(a.time).localeCompare(String(b.time)));

    const motivationalMessages = buildMotivationalMessages(selectedHabits, habits);

    res.json({
      success: true,
      dashboard: {
        dateKey,
        selectedHabits,
        habits,
        timeline,
        mood: entry.mood || { label: '', emoji: '' },
        weight: entry.weight,
        healthScore: {
          value: score.value,
          level: score.level,
        },
        ashaInsight: tipResult?.tip?.content || '',
        upcomingReminders,
        motivationalMessages,
      },
    });
  } catch (error) {
    console.error('habitTracker/dashboard error:', error);
    res.status(500).json({ success: false, message: 'Failed to load dashboard' });
  }
});

router.post('/log', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const { habitKey, value = 1, action = 'log', label, mood, weight } = req.body || {};

    if (!habitKey || !HABIT_DEFINITIONS[habitKey]) {
      return res.status(400).json({ success: false, message: 'Invalid habit key' });
    }

    const { entry, score } = await applyHabitLog({ userId, habitKey, value, action, label, mood, weight });

    res.json({
      success: true,
      entry: {
        dateKey: entry.dateKey,
        habits: entry.habits,
        mood: entry.mood,
        weight: entry.weight,
        healthScore: {
          value: score.value,
          level: score.level,
        },
        timeline: entry.timeline,
      },
      message: 'Habit logged',
    });
  } catch (error) {
    console.error('habitTracker/log error:', error);
    res.status(500).json({ success: false, message: 'Failed to log habit action' });
  }
});

router.post('/quick-action', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const { habitKey, value = 1, mood, weight, label } = req.body || {};

    if (!habitKey || !HABIT_DEFINITIONS[habitKey]) {
      return res.status(400).json({ success: false, message: 'Invalid habit key' });
    }

    if (habitKey === 'medication') {
      const medication = await Medication.findOne({ user: userId, isActive: true, remindMe: true }).sort({ createdAt: -1 });
      if (medication && Array.isArray(medication.scheduledTimes) && medication.scheduledTimes.length) {
        const idx = medication.scheduledTimes.findIndex((dose) => !dose?.taken);
        const indexToMark = idx >= 0 ? idx : 0;
        medication.scheduledTimes[indexToMark].taken = true;
        medication.scheduledTimes[indexToMark].takenAt = new Date();
        medication.scheduledTimes[indexToMark].skippedAt = null;
        medication.scheduledTimes[indexToMark].snoozedUntil = null;
        await medication.save();
      }
    }

    if (habitKey === 'bloodPressure' || habitKey === 'bloodSugar' || habitKey === 'heartRate' || habitKey === 'weight') {
      const vitalsPayload = { user: userId, source: 'manual' };
      if (habitKey === 'bloodPressure') {
        vitalsPayload.bloodPressure = { systolic: 120, diastolic: 80, raw: '120/80' };
      }
      if (habitKey === 'bloodSugar') {
        vitalsPayload.bloodSugar = { value: 102, unit: 'mg/dL', readingType: 'random', measuredAt: new Date() };
      }
      if (habitKey === 'heartRate') {
        vitalsPayload.heartRate = 74;
      }
      if (habitKey === 'weight' && Number.isFinite(Number(weight))) {
        vitalsPayload.weight = Number(weight);
      }
      await Vitals.create(vitalsPayload);
    }

    const { entry, score, selectedHabits } = await applyHabitLog({
      userId,
      habitKey,
      value,
      action: habitKey === 'weight' ? 'set' : 'log',
      mood,
      weight,
      label,
    });

    const motivationalMessages = buildMotivationalMessages(selectedHabits, entry.habits);
    const firstMotivation = motivationalMessages[0]?.message || MOTIVATIONAL_TEMPLATES[habitKey] || '';

    if (firstMotivation) {
      await HealthAlert.create({
        user: userId,
        type: 'health_insight',
        title: 'Daily Motivation',
        message: firstMotivation,
        severity: 'info',
        notificationType: 'in_app',
        notificationSent: false,
      });
    }

    res.json({
      success: true,
      entry: {
        dateKey: entry.dateKey,
        habits: entry.habits,
        mood: entry.mood,
        weight: entry.weight,
        healthScore: { value: score.value, level: score.level },
        timeline: entry.timeline,
      },
      motivation: firstMotivation,
    });
  } catch (error) {
    console.error('habitTracker/quick-action error:', error);
    res.status(500).json({ success: false, message: 'Failed to run quick action' });
  }
});

router.get('/motivations', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const goal = await getOrCreateGoal(userId);
    const dateKey = toDateKey(new Date(), getTrackerTimezone(goal));
    const selectedHabits = normalizeSelectedHabits(goal?.habitTracker?.selectedHabits || []);
    const entry = await getOrCreateEntry(userId, dateKey, selectedHabits);
    const messages = buildMotivationalMessages(selectedHabits, entry.habits);

    res.json({ success: true, messages });
  } catch (error) {
    console.error('habitTracker/motivations error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch motivational notifications' });
  }
});

router.get('/stats', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const range = String(req.query?.range || 'week').toLowerCase();
    const goal = await getOrCreateGoal(userId);
    const timezone = getTrackerTimezone(goal);
    const now = new Date();
    const endKey = toDateKey(now, timezone);
    const endDate = new Date(`${endKey}T00:00:00Z`);
    const startDate = new Date(endDate);

    if (range === 'today') {
      // Keep the current local day as the only stats day.
    } else if (range === 'month') {
      startDate.setUTCMonth(startDate.getUTCMonth() - 1);
      startDate.setUTCDate(startDate.getUTCDate() + 1);
    } else if (range === 'year') {
      startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);
      startDate.setUTCDate(startDate.getUTCDate() + 1);
    } else {
      startDate.setUTCDate(startDate.getUTCDate() - 6);
    }

    const startKey = startDate.toISOString().slice(0, 10);
    const dateKeys = listDateKeys(startKey, endKey);

    const selectedHabits = normalizeSelectedHabits(goal?.habitTracker?.selectedHabits || []);

    const entries = await HabitTrackerEntry.find({
      user: userId,
      dateKey: { $gte: startKey, $lte: endKey },
    })
      .sort({ dateKey: 1 })
      .lean();

    const daysInRange = dateKeys.length;
    const entriesByDate = new Map(entries.map((entry) => [entry.dateKey, entry]));

    const habits = selectedHabits.map((habitKey) => {
      const def = HABIT_DEFINITIONS[habitKey];
      const history = dateKeys.map((dateKey) => {
        const entry = entriesByDate.get(dateKey);
        const state = entry?.habits?.[habitKey];
        const target = Number(state?.target || def.target || 1);
        const progress = Number(state?.progress || 0);
        const completion = target > 0 ? Math.min(100, Math.round((progress / target) * 100)) : 0;
        return {
          dateKey: entry.dateKey,
          completion,
          completed: completion >= 100,
        };
      });

      const completionPercentage = history.length
        ? Math.round(history.reduce((sum, item) => sum + item.completion, 0) / history.length)
        : 0;

      const dailyAverage = history.length
        ? Number((history.reduce((sum, item) => sum + item.completion, 0) / history.length).toFixed(1))
        : 0;

      let longestStreak = 0;
      let currentStreak = 0;
      let activeStreak = 0;
      history.forEach((item) => {
        if (item.completed) {
          const previous = history[history.indexOf(item) - 1];
          activeStreak = previous?.completed && areConsecutiveDateKeys(previous.dateKey, item.dateKey)
            ? activeStreak + 1
            : 1;
          longestStreak = Math.max(longestStreak, activeStreak);
        } else {
          activeStreak = 0;
        }
      });

      for (let i = history.length - 1; i >= 0; i -= 1) {
        if (
          history[i].completed &&
          (currentStreak === 0 || areConsecutiveDateKeys(history[i].dateKey, history[i + 1]?.dateKey))
        ) currentStreak += 1;
        else break;
      }

      const missedDays = Math.max(0, daysInRange - history.filter((item) => item.completed).length);

      return {
        key: habitKey,
        title: def.title,
        completionPercentage,
        dailyAverage,
        longestStreak,
        currentStreak,
        missedDays,
        history,
      };
    });

    res.json({
      success: true,
      stats: {
        range,
        daysInRange,
        habits,
      },
    });
  } catch (error) {
    console.error('habitTracker/stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch habit tracker stats' });
  }
});

router.get('/achievements', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;

    const entries = await HabitTrackerEntry.find({ user: userId })
      .sort({ dateKey: 1 })
      .lean();

    const completedDays = entries.filter((entry) => Number(entry.healthScore || 0) >= 80).length;
    const excellentDays = entries.filter((entry) => Number(entry.healthScore || 0) >= 96).length;

    let currentStreak = 0;
    let longestStreak = 0;
    let active = 0;
    entries.forEach((entry, index) => {
      if (Number(entry.healthScore || 0) >= 80) {
        const previous = entries[index - 1];
        active = previous && Number(previous.healthScore || 0) >= 80 && areConsecutiveDateKeys(previous.dateKey, entry.dateKey)
          ? active + 1
          : 1;
        longestStreak = Math.max(longestStreak, active);
      } else {
        active = 0;
      }
    });

    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (
        Number(entries[i].healthScore || 0) >= 80 &&
        (currentStreak === 0 || areConsecutiveDateKeys(entries[i].dateKey, entries[i + 1]?.dateKey))
      ) currentStreak += 1;
      else break;
    }

    const badges = [
      {
        id: 'first-day',
        title: 'First Day',
        icon: 'flame',
        target: 1,
        progress: Math.min(1, entries.length),
      },
      {
        id: 'streak-7',
        title: '7 Day Streak',
        icon: 'flame',
        target: 7,
        progress: Math.min(7, longestStreak),
      },
      {
        id: 'streak-30',
        title: '30 Day Streak',
        icon: 'flame',
        target: 30,
        progress: Math.min(30, longestStreak),
      },
      {
        id: 'silver',
        title: 'Silver Health Champion',
        icon: 'medal',
        target: 7,
        progress: Math.min(7, completedDays),
      },
      {
        id: 'gold',
        title: 'Gold Health Champion',
        icon: 'trophy',
        target: 14,
        progress: Math.min(14, completedDays),
      },
      {
        id: 'diamond',
        title: 'Diamond Champion',
        icon: 'gem',
        target: 30,
        progress: Math.min(30, excellentDays),
      },
    ].map((badge) => ({
      ...badge,
      unlocked: badge.progress >= badge.target,
      percentage: Math.round((badge.progress / badge.target) * 100),
    }));

    res.json({
      success: true,
      achievements: {
        currentStreak,
        longestStreak,
        badges,
      },
    });
  } catch (error) {
    console.error('habitTracker/achievements error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch achievements' });
  }
});

module.exports = router;
