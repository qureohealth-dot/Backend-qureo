const express = require('express');
const router = express.Router();
const Vitals = require('../models/Vitals');
const HealthAlert = require('../models/HealthAlert');
const HealthMonitoringServiceEnhanced = require('../services/HealthMonitoringServiceEnhanced');
const auth = require('../middleware/auth');

const notifyForCurrentAbnormalVitals = async (userId) => {
  try {
    const latestReadings = await HealthMonitoringServiceEnhanced.fetchLatestVitalsOptimized(userId);
    const vitalAlerts = await HealthMonitoringServiceEnhanced.checkVitalReadings(userId, latestReadings);
    for (const alert of vitalAlerts) {
      if (!await HealthMonitoringServiceEnhanced.shouldRepeatVitalAlert(userId, alert)) continue;
      const savedAlert = await HealthAlert.create({ ...alert, user: userId });
      HealthMonitoringServiceEnhanced.sendNotification(userId, savedAlert).catch((notificationError) => {
        console.error('Immediate abnormal-vitals notification failed:', notificationError?.message || notificationError);
      });
    }
  } catch (alertError) {
    console.error('Immediate abnormal-vitals check failed:', alertError?.message || alertError);
  }
};

// Utility
const toDayKey = (date) => new Date(date).toISOString().slice(0, 10);

// Normalizers
const normalizeBloodSugar = (bloodSugar) => {
  if (!bloodSugar) return undefined;
  if (typeof bloodSugar === 'number') {
    return { value: bloodSugar, unit: 'mg/dL', readingType: 'other', measuredAt: new Date() };
  }
  if (typeof bloodSugar === 'object' && bloodSugar.value) {
    return {
      value: Number(bloodSugar.value),
      unit: bloodSugar.unit === 'mmol/L' ? 'mmol/L' : 'mg/dL',
      readingType: bloodSugar.readingType || 'other',
      measuredAt: bloodSugar.measuredAt ? new Date(bloodSugar.measuredAt) : new Date(),
    };
  }
  return undefined;
};

const normalizeAdherenceEvents = (adherenceEvents) => {
  if (!Array.isArray(adherenceEvents)) return [];
  return adherenceEvents
    .filter((event) => event && typeof event === 'object')
    .map((event) => ({
      medicationName: event.medicationName || undefined,
      scheduledTime: event.scheduledTime || undefined,
      status: event.status || 'taken',
      notes: event.notes || undefined,
      recordedAt: event.recordedAt ? new Date(event.recordedAt) : new Date(),
    }));
};

// GET all vitals
router.get('/', auth, async (req, res) => {
  try {
    const { limit = 50, skip = 0 } = req.query;
    const userId = req.userId;

    const vitals = await Vitals.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    const total = await Vitals.countDocuments({ user: userId });

    res.json({ vitals, pagination: { total, limit: parseInt(limit), skip: parseInt(skip) } });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// GET latest vitals
router.get('/latest', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const vitals = await Vitals.findOne({ user: userId }).sort({ createdAt: -1 });
    if (!vitals) return res.status(404).json({ message: 'No vitals found' });
    res.json({ vitals });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST new vitals (append to arrays on the latest user vitals record)
router.post('/', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const { bloodPressure, heartRate, temperature, oxygenLevel, bloodSugar, weight, symptoms, adherenceEvents, hydration, notes, source, deviceName } = req.body;

    let bpEntry;
    if (typeof bloodPressure === 'string') {
      const [systolic, diastolic] = bloodPressure.split('/').map(Number);
      bpEntry = { systolic, diastolic, raw: bloodPressure, measuredAt: new Date() };
    } else if (typeof bloodPressure === 'object' && bloodPressure !== null) {
      bpEntry = { ...bloodPressure, measuredAt: new Date() };
    }

    const hrEntry = heartRate !== undefined && heartRate !== null && heartRate !== '' ? { value: Number(heartRate), measuredAt: new Date() } : null;
    const tempEntry = temperature !== undefined && temperature !== null && temperature !== '' ? { value: Number(temperature), measuredAt: new Date() } : null;
    const o2Entry = oxygenLevel !== undefined && oxygenLevel !== null && oxygenLevel !== '' ? { value: Number(oxygenLevel), measuredAt: new Date() } : null;
    const sugarEntry = normalizeBloodSugar(bloodSugar);
    const weightEntry = weight !== undefined && weight !== null && weight !== '' ? { value: Number(weight), measuredAt: new Date() } : null;
    const hydrationEntry = hydration !== undefined && hydration !== null && hydration !== '' ? { value: Number(hydration), measuredAt: new Date() } : null;

    let vitals = await Vitals.findOne({ user: userId }).sort({ createdAt: -1 });

    if (!vitals) {
      vitals = new Vitals({
        user: userId,
        bloodPressure: bpEntry ? [bpEntry] : [],
        heartRate: hrEntry ? [hrEntry] : [],
        temperature: tempEntry ? [tempEntry] : [],
        oxygenLevel: o2Entry ? [o2Entry] : [],
        bloodSugar: sugarEntry ? [sugarEntry] : [],
        weight: weightEntry ? [weightEntry] : [],
        hydration: hydrationEntry ? [hydrationEntry] : [],
        symptoms: Array.isArray(symptoms) ? symptoms : (symptoms ? [symptoms] : []),
        adherenceEvents: normalizeAdherenceEvents(adherenceEvents),
        notes: Array.isArray(notes) ? notes : (notes ? [notes] : []),
        source: source || 'manual',
        deviceName,
      });
    } else {
      if (bpEntry) vitals.bloodPressure.push(bpEntry);
      if (hrEntry) vitals.heartRate.push(hrEntry);
      if (tempEntry) vitals.temperature.push(tempEntry);
      if (o2Entry) vitals.oxygenLevel.push(o2Entry);
      if (sugarEntry) vitals.bloodSugar.push(sugarEntry);
      if (weightEntry) vitals.weight.push(weightEntry);
      if (hydrationEntry) vitals.hydration.push(hydrationEntry);

      if (symptoms) {
        vitals.symptoms.push(...(Array.isArray(symptoms) ? symptoms : [symptoms]));
      }

      if (adherenceEvents) {
        vitals.adherenceEvents.push(...normalizeAdherenceEvents(adherenceEvents));
      }

      if (notes) {
        vitals.notes.push(...(Array.isArray(notes) ? notes : [notes]));
      }

      if (source) vitals.source = source;
      if (deviceName) vitals.deviceName = deviceName;
    }

    await vitals.save();
    await notifyForCurrentAbnormalVitals(userId);

    res.status(201).json({ message: 'Vitals recorded successfully', vitals });
  } catch (err) {
    console.error('Error saving vitals:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// PUT update vitals (append new entries)
router.put('/:id', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const vitalId = req.params.id;
    const updateData = req.body;

    const vitals = await Vitals.findById(vitalId);
    if (!vitals) return res.status(404).json({ message: 'Vitals not found' });
    if (vitals.user.toString() !== userId.toString()) return res.status(403).json({ message: 'Unauthorized' });

    if (updateData.heartRate !== undefined) {
      vitals.heartRate.push({ value: updateData.heartRate, measuredAt: new Date() });
    }
    if (updateData.temperature !== undefined) {
      vitals.temperature.push({ value: updateData.temperature, measuredAt: new Date() });
    }
    if (updateData.oxygenLevel !== undefined) {
      vitals.oxygenLevel.push({ value: updateData.oxygenLevel, measuredAt: new Date() });
    }
    if (updateData.weight !== undefined) {
      vitals.weight.push({ value: updateData.weight, measuredAt: new Date() });
    }
    if (updateData.hydration !== undefined) {
      vitals.hydration.push({ value: updateData.hydration, measuredAt: new Date() });
    } 
    console.log("money", updateData.bloodPressure)
    if (updateData.bloodPressure !== undefined) {
      let bpUpdate;
      if (typeof updateData.bloodPressure === 'string') {
        const [systolic, diastolic] = updateData.bloodPressure.split('/').map(Number);
        bpUpdate = { systolic, diastolic, raw: updateData.bloodPressure, measuredAt: new Date() };
      } else {
        bpUpdate = { ...updateData.bloodPressure, measuredAt: new Date() };
      }
      vitals.bloodPressure.push(bpUpdate);
    }
    if (updateData.bloodSugar !== undefined) {
      const sugarUpdate = normalizeBloodSugar(updateData.bloodSugar);
      if (sugarUpdate) vitals.bloodSugar.push(sugarUpdate);
    }
    if (updateData.symptoms !== undefined) {
      vitals.symptoms.push(...updateData.symptoms);
    }
    if (updateData.adherenceEvents !== undefined) {
      vitals.adherenceEvents.push(...normalizeAdherenceEvents(updateData.adherenceEvents));
    }
    if (updateData.notes !== undefined) {
      vitals.notes = updateData.notes;
    }

    await vitals.save();
    await notifyForCurrentAbnormalVitals(userId);
    res.json({ message: 'Vitals updated successfully', vitals });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// DELETE vitals
router.delete('/:id', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const vitalId = req.params.id;
    const vitals = await Vitals.findById(vitalId);
    if (!vitals) return res.status(404).json({ message: 'Vitals not found' });
    if (vitals.user.toString() !== userId.toString()) return res.status(403).json({ message: 'Unauthorized' });
    await Vitals.findByIdAndDelete(vitalId);
    res.json({ message: 'Vitals deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
