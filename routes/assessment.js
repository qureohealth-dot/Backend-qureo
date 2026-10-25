const express = require('express');
const router = express.Router();
const HealthAssessment = require('../models/HealthAssessment');
const auth = require('../middleware/auth');
const { sendOtp, verifyOtp } = require('../services/twilioVerify');
const { notifyUser } = require('../utils/notifyUser');

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isLikelyDuplicatePayload(current, incoming) {
  const sameName = normalizeText(current.fullName) === normalizeText(incoming.fullName);
  const sameGoal = normalizeText(current.goal) === normalizeText(incoming.goal);
  const sameAge = normalizeNum(current.age) === normalizeNum(incoming.age);
  const sameAgeRange = normalizeText(current.ageRange) === normalizeText(incoming.ageRange);
  const sameWeight = normalizeNum(current.weightKg) === normalizeNum(incoming.weightKg ?? incoming.weight);
  const sameHeight = normalizeNum(current.heightCm) === normalizeNum(incoming.heightCm ?? incoming.height);
  const sameMood = normalizeText(current.mood) === normalizeText(incoming.mood);
  const sameMedical =
    normalizeText(current.condition) === normalizeText(incoming.condition) &&
    normalizeText(current.allergy) === normalizeText(incoming.allergy) &&
    JSON.stringify(current.medications || []) === JSON.stringify(incoming.medications || []);
  const sameLifestyle =
    normalizeText(current.sleepLevel) === normalizeText(incoming.sleepLevel) &&
    normalizeText(current.smokeLevel) === normalizeText(incoming.smokeLevel) &&
    normalizeNum(current.score) === normalizeNum(incoming.score);
  const sameRaw = JSON.stringify(current.raw || {}) === JSON.stringify(incoming.raw || {});
  return sameName && sameGoal && (sameAge || sameAgeRange) && sameWeight && sameHeight &&
    sameMood && sameMedical && sameLifestyle && sameRaw;
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toStringOrEmpty(value) {
  return value === null || value === undefined ? '' : String(value);
}

function normalizeMedications(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function buildAssessmentPayload(data) {
  return {
    fullName: toStringOrEmpty(data.fullName).trim(),
    goal: toStringOrEmpty(data.goal).trim(),
    age: toNumberOrNull(data.age),
    ageRange: toStringOrEmpty(data.ageRange).trim(),
    dob: data.dob || null,
    gender: toStringOrEmpty(data.gender).trim(),
    bloodType: toStringOrEmpty(data.bloodType).trim(),
    phone: toStringOrEmpty(data.phone).trim(),
    countryCode: toStringOrEmpty(data.countryCode).trim(),
    phoneVerified: Boolean(data.phoneVerified),
    weightKg: toNumberOrNull(data.weightKg ?? data.weight),
    heightCm: toNumberOrNull(data.heightCm ?? data.height),
    fitnessLevel: toNumberOrNull(data.fitnessLevel),
    sleepLevel: toStringOrEmpty(data.sleepLevel).trim(),
    smokeLevel: toStringOrEmpty(data.smokeLevel).trim(),
    mood: toStringOrEmpty(data.mood).trim(),
    eatingHours: toStringOrEmpty(data.eatingHours).trim(),
    medications: normalizeMedications(data.medications),
    allergy: toStringOrEmpty(data.allergy).trim(),
    condition: toStringOrEmpty(data.condition).trim(),
    conditions: normalizeStringArray(data.conditions ?? data.condition),
    allergies: toStringOrEmpty(data.allergies ?? data.allergy).trim(),
    familyHistory: normalizeStringArray(data.familyHistory),
    surgeries: toStringOrEmpty(data.surgeries).trim(),
    hospitalizations: toStringOrEmpty(data.hospitalizations).trim(),
    checkupFrequency: toStringOrEmpty(data.checkupFrequency).trim(),
    exercise: toStringOrEmpty(data.exercise).trim(),
    smoking: toStringOrEmpty(data.smoking ?? data.smokeLevel).trim(),
    alcohol: toStringOrEmpty(data.alcohol).trim(),
    sleep: toStringOrEmpty(data.sleep ?? data.sleepLevel).trim(),
    stress: toStringOrEmpty(data.stress).trim(),
    notes: toStringOrEmpty(data.notes).trim(),
    score: toNumberOrNull(data.score),
    raw: data.raw && typeof data.raw === 'object' ? data.raw : {},
    metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
  };
}

// GET /api/assessment - list assessments for the current user
router.get('/', auth, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ message: 'Sign in is required.' });
    }
    const latest = await HealthAssessment.findOne({ user: req.userId }).sort({ updatedAt: -1, createdAt: -1 });
    // Keep response shape compatible with frontend while enforcing single-record behavior.
    res.json({ assessments: latest ? [latest] : [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

async function upsertSingleAssessment(req, res) {
  try {
    const data = req.body || {};
    const uid = req.userId;
    if (!uid) {
      return res.status(401).json({ message: 'Sign in is required.' });
    }
    const payload = buildAssessmentPayload(data);

    const existing = await HealthAssessment.findOne({ user: uid }).sort({ updatedAt: -1, createdAt: -1 });

    if (existing) {
      if (isLikelyDuplicatePayload(existing, payload)) {
        return res.status(200).json({
          assessment: existing,
          duplicate: true,
          message: 'Duplicate assessment ignored',
        });
      }

      // Older clients do not send the richer mobile-only fields. Preserve those
      // values when the legacy assessment screen updates the shared record.
      const optionalFieldSources = {
        phone: ['phone'],
        countryCode: ['countryCode'],
        phoneVerified: ['phoneVerified'],
        conditions: ['conditions'],
        allergies: ['allergies'],
        familyHistory: ['familyHistory'],
        surgeries: ['surgeries'],
        hospitalizations: ['hospitalizations'],
        exercise: ['exercise'],
        smoking: ['smoking', 'smokeLevel'],
        alcohol: ['alcohol'],
        sleep: ['sleep', 'sleepLevel'],
        stress: ['stress'],
      };
      Object.entries(optionalFieldSources).forEach(([field, sourceFields]) => {
        const wasProvided = sourceFields.some((sourceField) =>
          Object.prototype.hasOwnProperty.call(data, sourceField)
        );
        if (!wasProvided) delete payload[field];
      });

      payload.raw = { ...(existing.raw || {}), ...(payload.raw || {}) };
      payload.metadata = { ...(existing.metadata || {}), ...(payload.metadata || {}) };
      Object.assign(existing, payload);
      await existing.save();

      try {
        await notifyUser({
          userId: uid,
          type: 'assessment_ready',
          title: 'Your assessment has been updated',
          body: 'Your latest assessment is ready in Qureo.',
          balancedTitle: 'Assessment updated',
          balancedBody: 'Your health assessment was updated.',
          genericTitle: 'You have a new update in Qureo',
          genericBody: 'Open Qureo to review your assessment and next step.',
          route: '/health-assessment',
          data: {
            assessmentId: String(existing._id),
            updated: true,
          },
        });
      } catch (notifyError) {
        console.warn('[assessment] push failed after update:', notifyError?.message || notifyError);
      }

      // Ensure one assessment per user by cleaning stale duplicates if they exist.
      await HealthAssessment.deleteMany({ user: uid, _id: { $ne: existing._id } });

      return res.status(200).json({ assessment: existing, duplicate: false, updated: true });
    }

    const a = new HealthAssessment({ user: uid, ...payload });
    await a.save();

    try {
      await notifyUser({
        userId: uid,
        type: 'assessment_ready',
        title: 'Your assessment is ready',
        body: 'Your health journey update is ready in Qureo.',
        balancedTitle: 'Assessment ready',
        balancedBody: 'Your assessment has been completed.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to review your assessment and next step.',
        route: '/health-assessment',
        data: {
          assessmentId: String(a._id),
          updated: false,
        },
      });
    } catch (notifyError) {
      console.warn('[assessment] push failed after create:', notifyError?.message || notifyError);
    }

    return res.status(201).json({ assessment: a, duplicate: false, updated: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// POST /api/assessment/phone/send-code
router.post('/phone/send-code', auth, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ message: 'Sign in is required.' });
    }
    const result = await sendOtp({
      phone: req.body?.phone,
      userId: req.userId,
      channel: 'sms',
    });
    return res.json({
      sent: true,
      status: result.status,
      phone: result.to,
      ...(result.provider === 'dev-fallback' && result.developmentCode
        ? { developmentCode: result.developmentCode }
        : {}),
    });
  } catch (err) {
    const status = err?.code === 'INVALID_PHONE' ? 400 : 502;
    return res.status(status).json({ message: err?.message || 'Unable to send verification code.' });
  }
});

// POST /api/assessment/phone/verify-code
router.post('/phone/verify-code', auth, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ message: 'Sign in is required.' });
    }
    const result = await verifyOtp({
      phone: req.body?.phone,
      userId: req.userId,
      code: req.body?.code,
    });
    if (!result.approved) {
      return res.status(400).json({
        approved: false,
        status: result.status,
        message: 'The verification code is incorrect or has expired.',
      });
    }
    return res.json({ approved: true, status: result.status });
  } catch (err) {
    const status = ['INVALID_PHONE', 'INVALID_OTP'].includes(err?.code) ? 400 : 502;
    return res.status(status).json({ message: err?.message || 'Unable to verify code.' });
  }
});

// POST /api/assessment - create or update the single assessment record
router.post('/', auth, upsertSingleAssessment);

// PUT /api/assessment - explicit update endpoint (same single-record semantics)
router.put('/', auth, upsertSingleAssessment);

module.exports = router;
