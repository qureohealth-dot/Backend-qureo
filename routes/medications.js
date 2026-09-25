const express = require('express');
const router = express.Router();
const UserMedication = require('../models/UserMedication');
const auth = require('../middleware/auth');
const { notifyUser } = require('../utils/notifyUser');


const buildNotExpiredFilter = (now = new Date()) => ({
  $or: [
    { durationEndDate: { $exists: false } },
    { durationEndDate: null },
    { durationEndDate: { $gt: now } },
  ],
});

const normalizeEndDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(23, 59, 59, 999);
  return date;
};

/**
 * USER MEDICATIONS API
 * Endpoints for managing user's active medications and prescriptions
 */

// ✅ GET /api/medications - Get all active medications for user
router.get('/', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const { isActive = true, limit = 50, skip = 0 } = req.query;
    const now = new Date();

    const query = { user: userId };
    if (isActive === 'true') {
      query.isActive = true;
      Object.assign(query, buildNotExpiredFilter(now));
    }

    const medications = await UserMedication.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    const total = await UserMedication.countDocuments(query);

    res.json({
      medications,
      pagination: {
        total,
        limit: parseInt(limit),
        skip: parseInt(skip),
      },
    });
  } catch (err) {
    console.error('Error fetching medications:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ✅ GET /api/medications/:id - Get single medication details
router.get('/:id', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const medicationId = req.params.id;
    const now = new Date();

    const medication = await UserMedication.findOne({
      _id: medicationId,
      user: userId,
      ...buildNotExpiredFilter(now),
    });

    if (!medication) {
      return res.status(404).json({ message: 'Medication not found' });
    }

    res.json({ medication });
  } catch (err) {
    console.error('Error fetching medication:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ✅ POST /api/medications - Add new medication
router.post('/', auth, async (req, res) => {
    console.log("req body", req.body)  
   try {
    const userId = req.userId;
    const {
      medicineName,
      brandName,
      genericName,
      strength,
      doctorName,
      prescriptionDate,
      dosages, // Array of { time: "08:00 AM", taken: false }
      frequency,
      duration,
      durationEndDate,
      timezone,
      instructions,
      sideEffects,
      category,
    } = req.body;

    // Validate required fields
    if (!medicineName || !dosages || dosages.length === 0) {
      return res.status(400).json({
        message: 'Medicine name and at least one dosage time are required',
      });
    }

    const newMedication = new UserMedication({
      user: userId,
      medicineName,
      brandName,
      genericName,
      strength,
      doctorName,
      prescriptionDate: prescriptionDate || new Date(),
      dosages: dosages.map(d => ({
        time: d.time,
        taken: false,
      })),
      frequency,
      duration,
      durationEndDate: normalizeEndDate(durationEndDate),
      timezone: typeof timezone === 'string' && timezone.trim() ? timezone.trim() : 'UTC',
      instructions,
      sideEffects,
      category,
      isActive: true,
    });

    await newMedication.save();

    try {
      await notifyUser({
        userId,
        type: 'medication_reminder',
        title: 'Medication added',
        body: `${medicineName} was added to your medication list.`,
        balancedTitle: 'Medication reminder set',
        balancedBody: 'A medication was added to your schedule.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to view your medication schedule.',
        route: '/reminders',
        data: {
          medicationId: String(newMedication._id),
          medicineName,
          frequency: String(frequency || ''),
        },
      });
    } catch (notifyError) {
      console.warn('[medications] push failed after add:', notifyError?.message || notifyError);
    }

    res.status(201).json({
      message: 'Medication added successfully',
      medication: newMedication,
    });
  } catch (err) {
    console.error('Error adding medication:', err);
    res.status(500).json({ message: 'Failed to add medication', error: err.message });
  }
});

// ✅ PUT /api/medications/:id - Update medication
router.put('/:id', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const medicationId = req.params.id;
    const updates = req.body;
    const now = new Date();

    const medication = await UserMedication.findOne({
      _id: medicationId,
      user: userId,
      ...buildNotExpiredFilter(now),
    });

    if (!medication) {
      return res.status(404).json({ message: 'Medication not found' });
    }

    // Update allowed fields
    const allowedUpdates = [
      'medicineName',
      'brandName',
      'genericName',
      'strength',
      'doctorName',
      'frequency',
      'duration',
      'durationEndDate',
      'timezone',
      'instructions',
      'sideEffects',
      'category',
      'isActive',
      'dosages',
    ];

    Object.keys(updates).forEach(key => {
      if (allowedUpdates.includes(key)) {
        medication[key] = key === 'durationEndDate' ? normalizeEndDate(updates[key]) : updates[key];
      }
    });

    await medication.save();

    res.json({
      message: 'Medication updated successfully',
      medication,
    });
  } catch (err) {
    console.error('Error updating medication:', err);
    res.status(500).json({ message: 'Failed to update medication', error: err.message });
  }
});

// ✅ POST /api/medications/:id/mark-dose - Mark a dose as taken
router.post('/:id/mark-dose', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const medicationId = req.params.id;
    const { dosageTime, notes } = req.body; // dosageTime = "08:00 AM"
    const now = new Date();

    const medication = await UserMedication.findOne({ 
      _id: medicationId,
      user: userId,
      ...buildNotExpiredFilter(now),
    });

    if (!medication) {
      return res.status(404).json({ message: 'Medication not found' });
    }

    // Find and mark the dosage
    const dosage = medication.dosages.find(d => d.time === dosageTime);

    if (!dosage) {
      return res.status(404).json({ message: 'Dosage time not found' });
    }

    if (!dosage.taken) {
      dosage.taken = true;
      dosage.takenAt = new Date();
      dosage.notes = notes || '';
      medication.completedDoses = (medication.completedDoses || 0) + 1;
      medication.calculateAdherence();
    }

    await medication.save();

    try {
      await notifyUser({
        userId,
        type: 'medication_reminder',
        title: 'Dose marked as taken',
        body: `${medication.medicineName} was marked as taken.`,
        balancedTitle: 'Medication updated',
        balancedBody: 'Your dose status was updated.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to review your medication progress.',
        route: '/reminders',
        data: {
          medicationId: String(medication._id),
          dosageTime: String(dosageTime || ''),
          status: 'taken',
        },
      });
    } catch (notifyError) {
      console.warn('[medications] push failed after mark-dose:', notifyError?.message || notifyError);
    }

    res.json({
      message: 'Dose marked as taken',
      medication,
      adherencePercentage: medication.adherencePercentage,
    });
  } catch (err) {
    console.error('Error marking dose:', err);
    res.status(500).json({ message: 'Failed to mark dose', error: err.message });
  }
});

// ✅ POST /api/medications/:id/mark-missed - Mark a dose as missed
router.post('/:id/mark-missed', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const medicationId = req.params.id;
    const { dosageTime, reason } = req.body;
    const now = new Date();

    const medication = await UserMedication.findOne({
      _id: medicationId,
      user: userId,
      ...buildNotExpiredFilter(now),
    });

    if (!medication) {
      return res.status(404).json({ message: 'Medication not found' });
    }

    const dosage = medication.dosages.find(d => d.time === dosageTime);

    if (!dosage) {
      return res.status(404).json({ message: 'Dosage time not found' });
    }

    if (!dosage.taken) {
      medication.missedDoses = (medication.missedDoses || 0) + 1;
      dosage.notes = `Missed - ${reason || 'No reason provided'}`;
      medication.calculateAdherence();
    }

    await medication.save();

    try {
      await notifyUser({
        userId,
        type: 'medication_reminder',
        title: 'Missed dose recorded',
        body: `${medication.medicineName} was marked as missed.`,
        balancedTitle: 'Medication reminder',
        balancedBody: 'A dose was marked as missed.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to review your medication schedule.',
        route: '/reminders',
        data: {
          medicationId: String(medication._id),
          dosageTime: String(dosageTime || ''),
          status: 'missed',
        },
      });
    } catch (notifyError) {
      console.warn('[medications] push failed after mark-missed:', notifyError?.message || notifyError);
    }

    res.json({
      message: 'Dose marked as missed',
      medication,
      adherencePercentage: medication.adherencePercentage,
    });
  } catch (err) {
    console.error('Error marking missed dose:', err);
    res.status(500).json({ message: 'Failed to mark missed dose', error: err.message });
  }
});

// ✅ POST /api/medications/:id/complete - Mark medication as completed
router.post('/:id/complete', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const medicationId = req.params.id;
    const now = new Date();

    const medication = await UserMedication.findOne({
      _id: medicationId,
      user: userId,
      ...buildNotExpiredFilter(now),
    });

    if (!medication) {
      return res.status(404).json({ message: 'Medication not found' });
    }

    medication.isCompleted = true;
    medication.isActive = false;

    await medication.save();

    try {
      await notifyUser({
        userId,
        type: 'progress_update',
        title: 'Medication completed',
        body: `${medication.medicineName} was marked as completed.`,
        balancedTitle: 'Medication completed',
        balancedBody: 'Your medication course was completed.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to view your health journey update.',
        route: '/reminders',
        data: {
          medicationId: String(medication._id),
          status: 'completed',
        },
      });
    } catch (notifyError) {
      console.warn('[medications] push failed after complete:', notifyError?.message || notifyError);
    }

    res.json({
      message: 'Medication marked as completed',
      medication,
    });
  } catch (err) {
    console.error('Error completing medication:', err);
    res.status(500).json({ message: 'Failed to complete medication', error: err.message });
  }
});

// ✅ DELETE /api/medications/:id - Delete medication
router.delete('/:id', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const medicationId = req.params.id;

    const medication = await UserMedication.findOneAndDelete({
      _id: medicationId,
      user: userId,
    });

    if (!medication) {
      return res.status(404).json({ message: 'Medication not found' });
    }

    res.json({ message: 'Medication deleted successfully' });
  } catch (err) {
    console.error('Error deleting medication:', err);
    res.status(500).json({ message: 'Failed to delete medication', error: err.message });
  }
});

// ✅ GET /api/medications/today/pending - Get medications due today
router.get('/today/pending', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const now = new Date();

    const medications = await UserMedication.find({
      user: userId,
      isActive: true,
      ...buildNotExpiredFilter(now),
    });

    // Filter to show pending doses for today
    const pendingToday = medications
      .map(med => ({
        _id: med._id,
        medicineName: med.medicineName,
        strength: med.strength,
        dosages: med.dosages.filter(d => !d.taken),
        adherencePercentage: med.adherencePercentage,
      }))
      .filter(med => med.dosages.length > 0);

    res.json({
      pendingMedications: pendingToday,
      totalPending: pendingToday.length,
    });
  } catch (err) {
    console.error('Error fetching pending medications:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
