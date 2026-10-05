const express = require("express");
const router = express.Router();
const mongoose = require('mongoose');
const crypto = require('crypto');
const Doctor = require("../models/Doctor");
const Consultation = require('../models/Consultations');
const Transaction = require('../models/Transaction');
const bcrypt = require("bcryptjs");
const doctorAuth = require('../middleware/doctorAuth');
const jwt = require("jsonwebtoken")// ✅ Register Doctor
const { notifyUser } = require('../utils/notifyUser');
const Wallet = require('../models/Wallet');

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.AUTH_SECRET ||
  (process.env.NODE_ENV === 'production' ? '' : 'qureo-local-dev-auth-secret');

// ✅ Register Doctor
router.post("/", async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      specialty,
      experience,
      licenseNumber,
      clinicName,
      atAGlance,
      doctorCode,
      avatar,
      city,
      description,
      certified,
      skills,
      languagesSpoken,
      availability,
      education,
      location, // expected: { type: "Point", coordinates: [lng, lat] }
    } = req.body;

    // ---- Basic validation ----
    if (!name || !email || !password || !specialty) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // ---- Check if doctor already exists ----
    const existing = await Doctor.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: "Doctor already exists" });
    }

    // ---- Hash password ----
    const passwordHash = await bcrypt.hash(password, 10);

    // ---- Normalize location ----
    let normalizedLocation;

    if (
      location &&
      location.type === "Point" &&
      Array.isArray(location.coordinates) &&
      location.coordinates.length === 2 &&
      (location.coordinates[0] !== 0 || location.coordinates[1] !== 0)
    ) {
      normalizedLocation = {
        type: "Point",
        coordinates: [
          Number(location.coordinates[0]),
          Number(location.coordinates[1]),
        ],
      };
    }

    // ---- Create doctor ----
    const newDoctor = new Doctor({
      name,
      email,
      phone,
      passwordHash,
      specialty,
      experience,
      licenseNumber,
      clinicName,
      atAGlance,
      doctorCode,
      avatar,
      city,
      description,
      certified: Boolean(certified),
      skills: skills ?? [],
      languagesSpoken: languagesSpoken ?? [],
      availability: availability ?? {},
      education: education ?? [],
      ...(normalizedLocation && { location: normalizedLocation }),
    });

    await newDoctor.save();
    await Wallet.findOneAndUpdate(
      { user: newDoctor._id },
      { $setOnInsert: { balance: 0, currency: 'USD', status: 'active' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    try {
      await notifyUser({
        userId: newDoctor._id,
        type: 'account_security_alert',
        title: 'Doctor profile created',
        body: 'Your doctor account was created successfully.',
        balancedTitle: 'Doctor account ready',
        balancedBody: 'Your doctor profile is ready in Qureo.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to finish setup.',
        route: '/home',
        data: {
          event: 'doctor_signup',
          doctorId: String(newDoctor._id),
        },
      });
    } catch (notifyError) {
      console.warn('[doctor] push failed after register:', notifyError?.message || notifyError);
    }

    // ---- Remove sensitive fields from response ----
    const doctorResponse = newDoctor.toObject();
    delete doctorResponse.passwordHash;

    const token = jwt.sign({ sub: String(newDoctor._id), role: 'doctor' }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({
      message: "Doctor registered successfully",
      doctor: doctorResponse,
      token,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // ---- Validate input ----
    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required",
      });
    }

    // ---- Find doctor ----
    const doctor = await Doctor.findOne({ email });
    if (!doctor) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    // ---- Compare password ----
    const isMatch = await bcrypt.compare(password, doctor.passwordHash);
    if (!isMatch) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    // ---- Clean response ----
    const doctorResponse = doctor.toObject();
    delete doctorResponse.passwordHash;

    await Wallet.findOneAndUpdate(
      { user: doctor._id },
      { $setOnInsert: { balance: 0, currency: 'USD', status: 'active' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const token = jwt.sign({ sub: String(doctor._id), role: 'doctor' }, JWT_SECRET, { expiresIn: '7d' });

    try {
      const upcomingPatients = await Consultation.find({
        doctor: doctor._id,
        status: { $in: ['scheduled', 'confirmed', 'pending'] },
        appointmentTime: { $gte: new Date(), $lte: new Date(Date.now() + 60 * 60 * 1000) },
      }).select('patient appointmentTime roomId').lean();

      for (const consultation of upcomingPatients.slice(0, 10)) {
        await notifyUser({
          userId: consultation.patient,
          type: 'consultation_started',
          title: 'Doctor is online',
          body: 'Your doctor is online and available now.',
          balancedTitle: 'Doctor online',
          balancedBody: 'Your doctor is available now.',
          genericTitle: 'You have a new update in Qureo',
          genericBody: 'Open Qureo to join your consultation.',
          route: '/doctor-consult',
          data: {
            consultationId: String(consultation._id),
            roomId: String(consultation.roomId || ''),
            doctorId: String(doctor._id),
            event: 'doctor_online',
          },
        });
      }
    } catch (notifyError) {
      console.warn('[doctor] push failed after login:', notifyError?.message || notifyError);
    }

    res.status(200).json({

      message: "Login successful",
      doctor: doctorResponse,
      token,
    });

    
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Server error",
    });
  }
});


// POST /api/doctor/bulk
router.post("/bulk", async (req, res) => {
    console.log("bulk")
  try {

    const doctors = req.body; // expecting an array
    const created = await Doctor.insertMany(doctors);
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to insert doctors" });
  }
});

// ✅ UPDATE doctor location
router.put("/:id/location", async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    if (!latitude || !longitude) {
      return res.status(400).json({ message: "Latitude and longitude required" });
    }

    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) return res.status(404).json({ message: "Doctor not found" });

    doctor.location = {
      type: 'Point',
      coordinates: [longitude, latitude], // GeoJSON requires [lng, lat]
    };

    await doctor.save();
    res.json({ message: "Location updated", location: doctor.location });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ✅ FIND doctors near a location
// Query params: ?lat=...&lng=...&radius=km
router.get("/nearby", async (req, res) => {
  try {
    const { lat, lng, radius } = req.query;
    // validate numeric query params
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return res.status(400).json({ message: "Invalid latitude or longitude" });
    }

    const radiusNum = parseFloat(radius);
    const distance = (Number.isFinite(radiusNum) ? radiusNum : 5) * 1000; // convert km to meters

    const doctors = await Doctor.find({
      isSuspended: { $ne: true },
      location: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [lngNum, latNum],
          },
          $maxDistance: distance,
        },
      },
    }, { passwordHash: 0 });

    res.json(doctors);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch nearby doctors" });
  }
});

// GET /api/doctors/search?query=keyword
router.get("/search", async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ message: "Query parameter is required" });
    }

    // Case-insensitive partial match for multiple fields
    const regex = new RegExp(query, "i");

    const doctors = await Doctor.find({
      isSuspended: { $ne: true },
      $or: [
        { name: regex },
        { specialty: regex },
        { city: regex },
        { skills: regex },
      ],
    }, { passwordHash: 0 });

    res.json({ results: doctors });
  } catch (err) {
    console.error("❌ Error searching doctors:", err);
    res.status(500).json({ message: "Failed to search doctors" });
  }
});


router.get("/specialty/:specialty",  async (req, res) => {
  try {
    const { specialty } = req.params;
    const doctors = await Doctor.find({
      specialty: { $regex: new RegExp(specialty, "i") },
      isSuspended: { $ne: true },
    }, { passwordHash: 0 }); // case-insensitive search
    res.json(doctors);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch doctors", error: err.message });
  }
});



// ✅ Get All Doctors
router.get("/", async (req, res) => {
  try {
    const includeSuspended = req.query.includeSuspended === "true";
    const filter = includeSuspended ? {} : { isSuspended: { $ne: true } };
    const doctors = await Doctor.find(
      filter,
      { passwordHash: 0 }
    ).sort({ createdAt: -1 });
    res.json(doctors);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/active", async (req, res) => {
  try {
    const doctors = await Doctor.find(
      { certified: true, isSuspended: { $ne: true } },
      { passwordHash: 0 } // exclude sensitive fields
    ).sort({ createdAt: -1 });

    res.status(200).json({
      count: doctors.length,
      doctors,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to fetch active doctors",
    });
  }
});
router.get("/available", async (req, res) => {
  try {
    const {
      specialty,
      city,
      skill,
      language,
    } = req.query;

    const query = {
      certified: true,
      isSuspended: { $ne: true },
      "availability.isAvailable": true,
    };

    if (specialty) {
      query.specialty = specialty;
    }

    if (city) {
      query.city = city;
    }

    if (skill) {
      query.skills = { $in: [skill] };
    }

    if (language) {
      query.languagesSpoken = { $in: [language] };
    }

    const doctors = await Doctor.find(query, {
      passwordHash: 0,
    });

    res.status(200).json({
      count: doctors.length,
      doctors,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to fetch available doctors",
    });
  }
});


function getTodayKey() {
  return new Date()
    .toLocaleDateString("en-US", { weekday: "long" })
    .toLowerCase();
}

router.get("/smart", async (req, res) => {
  try {
    const {
      active,
      available,
      online,
      recommended,
      specialty,
      city,
      skill,
      language,
      page = 1,
      limit = 20,
    } = req.query;

    const todayKey = getTodayKey();
    const query = { isSuspended: { $ne: true } };

    // ---- Filters ----
    if (active === "true") query.certified = true;

    if (available === "true") {
      query[`availability.${todayKey}`] = { $exists: true, $ne: [] };
    }

    if (online === "true") {
      query.isOnline = true;
      query[`availability.${todayKey}`] = { $exists: true, $ne: [] };
    }

    if (specialty) query.specialty = specialty;
    if (city) query.city = city;
    if (skill) query.skills = { $in: [skill] };
    if (language) query.languagesSpoken = { $in: [language] };

    const skip = (Number(page) - 1) * Number(limit);

    // ---- Sorting logic ----
    const sort = {};

    if (recommended === "true") {
      sort.experience = -1; // 🔥 most experienced first
    } else {
      sort.createdAt = -1; // default
    }

    const [doctors, total] = await Promise.all([
      Doctor.find(query, { passwordHash: 0 })
        .sort(sort)
        .skip(skip)
        .limit(Number(limit)),
      Doctor.countDocuments(query),
    ]);

    res.status(200).json({
      today: todayKey,
      recommended: recommended === "true",
      page: Number(page),
      limit: Number(limit),
      total,
      count: doctors.length,
      doctors,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to fetch doctors",
    });
  }
});



router.get("/online", async (req, res) => {
  try {
    const todayKey = getTodayKey();

    const doctors = await Doctor.find(
      {
        isOnline: true,
        isSuspended: { $ne: true },
        [`availability.${todayKey}`]: { $exists: true, $ne: [] },
      },
      { passwordHash: 0 }
    ).sort({ updatedAt: -1 });

    res.status(200).json({
      today: todayKey,
      count: doctors.length,
      doctors,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to fetch online doctors",
    });
  }
});


// Get currently authenticated doctor profile
router.put('/availability', doctorAuth, async (req, res) => {
  try {
    const dayNames = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const input = req.body?.availability;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return res.status(400).json({ message: 'Availability schedule is required' });
    }

    const availability = {};
    for (const day of dayNames) {
      const slots = input[day] ?? [];
      if (!Array.isArray(slots) || slots.length > 8) {
        return res.status(400).json({ message: `Availability for ${day} must contain up to 8 time slots` });
      }
      const normalizedSlots = slots.map((slot) => String(slot).trim());
      const parsedSlots = normalizedSlots.map((slot) => {
        const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(slot);
        if (!match) return null;
        const start = Number(match[1]) * 60 + Number(match[2]);
        const end = Number(match[3]) * 60 + Number(match[4]);
        return start < end && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3]) < 24 && Number(match[4]) < 60
          ? { start, end, value: slot }
          : null;
      });
      if (parsedSlots.some((slot) => !slot)) {
        return res.status(400).json({ message: `Availability for ${day} contains an invalid time range` });
      }
      parsedSlots.sort((a, b) => a.start - b.start);
      if (parsedSlots.some((slot, index) => index > 0 && slot.start < parsedSlots[index - 1].end)) {
        return res.status(400).json({ message: `Availability for ${day} contains overlapping time slots` });
      }
      availability[day] = parsedSlots.map((slot) => slot.value);
    }

    req.doctor.availability = availability;
    await req.doctor.save();
    return res.json({ availability: req.doctor.availability });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to update availability', error: err.message });
  }
});

router.get('/wallet', doctorAuth, async (req, res) => {
  try {
    const wallet = await Wallet.findOneAndUpdate(
      { user: req.doctorId },
      { $setOnInsert: { balance: 0, currency: 'USD', status: 'active' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const transactions = await Transaction.find({ user: req.doctorId }).sort({ createdAt: -1 }).limit(100).lean();
    return res.json({ wallet, transactions });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to load doctor wallet', error: err.message });
  }
});

router.post('/wallet/withdraw', doctorAuth, async (req, res) => {
  const amount = Number(req.body?.amount);
  const withdrawalMethod = String(req.body?.withdrawalMethod || 'bank_transfer');
  const accountDetails = req.body?.accountDetails;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    return res.status(400).json({ message: 'Enter a valid withdrawal amount' });
  }
  if (!accountDetails || typeof accountDetails !== 'object' || !Object.values(accountDetails).some((value) => String(value || '').trim())) {
    return res.status(400).json({ message: 'Withdrawal account details are required' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const wallet = await Wallet.findOne({ user: req.doctorId }).session(session);
    if (!wallet || wallet.status !== 'active') {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Active wallet not found' });
    }
    if (Number(wallet.balance) < amount) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Withdrawal amount exceeds your available balance' });
    }

    const previousBalance = Number(wallet.balance || 0);
    wallet.balance = previousBalance - amount;
    wallet.totalWithdrawals = Number(wallet.totalWithdrawals || 0) + amount;
    wallet.lastTransaction = new Date();
    await wallet.save({ session });
    const [transaction] = await Transaction.create([{
      wallet: wallet._id,
      user: req.doctor._id,
      type: 'withdrawal',
      amount,
      previousBalance,
      newBalance: wallet.balance,
      status: 'pending',
      paymentMethod: withdrawalMethod,
      description: `Doctor withdrawal request of $${amount.toFixed(2)}`,
      reference: `DOC-WITH-${crypto.randomUUID()}`,
      metadata: { accountDetails },
    }], { session });
    await session.commitTransaction();
    return res.status(202).json({ message: 'Withdrawal request submitted', transactionId: transaction._id, balance: wallet.balance });
  } catch (err) {
    await session.abortTransaction();
    return res.status(500).json({ message: 'Failed to submit withdrawal request', error: err.message });
  } finally {
    await session.endSession();
  }
});

router.get('/me', doctorAuth, async (req, res) => {
  try {
    // doctorAuth attaches `req.doctor`
    res.json(req.doctor);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch profile', error: err.message });
  }
});
router.get('/delete', async (req, res) => {
  try {
    const result = await Doctor.deleteMany({});
    console.log('Doctor collection cleared');
    res.status(200).json({ message: 'All doctors deleted', deletedCount: result.deletedCount });
  } catch (error) {
    console.error('Error deleting doctors:', error);
    res.status(500).json({ error: 'Failed to delete doctors' });
  }
});


// ✅ Delete Doctor by ID
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await Doctor.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Doctor not found" });
    res.json({ message: "Doctor deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ✅ Add Comment
router.post("/:id/comment", async (req, res) => {
  const { user, comment } = req.body;

  try {
    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    // Initialize comments if undefined
    if (!Array.isArray(doctor.comments)) {
      doctor.comments = [];
    }

    doctor.comments.push({
      user,
      comment,
      date: new Date(),
    });

    await doctor.save();
    res.json({
      message: "Comment added successfully",
      doctor,
    });
  } catch (err) {
    console.error("❌ Error adding comment:", err);
    res.status(500).json({ message: "Failed to add comment", error: err.message });
  }
});

// ✅ Add / update rating
router.post("/:id/rate", async (req, res) => {
  try {
    const { rating } = req.body;
    const ratingNum = Number(rating);

    if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ message: "Rating must be a number between 1 and 5" });
    }

    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    if (!Array.isArray(doctor.ratings)) doctor.ratings = [];

    doctor.ratings.push({ user: "patient", rating: ratingNum, date: new Date() });

    const total = doctor.ratings.reduce((sum, r) => sum + Number(r.rating || 0), 0);
    doctor.averageRating = Math.round((total / doctor.ratings.length) * 10) / 10;

    await doctor.save();

    res.json({ message: "Rating saved", averageRating: doctor.averageRating });
  } catch (err) {
    console.error("❌ Error saving rating:", err);
    res.status(500).json({ message: "Failed to save rating", error: err.message });
  }
});

router.get('/location-name', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return res.status(400).json({ message: 'Valid latitude and longitude are required' });
  }

  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));

    const response = await fetch(url, {
      headers: { 'User-Agent': 'QureoHealth/1.0 (location lookup)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return res.status(502).json({ message: 'Location lookup is temporarily unavailable' });
    }

    const result = await response.json();
    const address = result.address || {};
    const name = address.city || address.town || address.village || address.suburb ||
      address.neighbourhood || address.county || result.display_name || '';

    return res.json({ name });
  } catch (error) {
    console.warn('[doctor] Reverse geocoding failed:', error?.message || error);
    return res.status(502).json({ message: 'Location lookup is temporarily unavailable' });
  }
});

router.get("/:id", async (req, res) => {
  const { id } = req.params;



  try {
    const doctor = await Doctor.findById(id).lean();
    if (!doctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }
    res.json(doctor);
  } catch (err) {
    console.error("Error fetching doctor:", err);
    res.status(500).json({ message: "Server error" });
  }
});



// ✅ Update Certification, Skills, or More Options
router.put("/:id/update", async (req, res) => {
  try {
    const updates = req.body; // e.g. { certified: true, skills: ["Surgery", "Cardiology"], moreOptions: { language: "English" } }
    const doctor = await Doctor.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
      projection: { passwordHash: 0 },
    });
    if (!doctor) return res.status(404).json({ message: "Doctor not found" });

    if (Object.prototype.hasOwnProperty.call(updates, 'isOnline') && updates.isOnline === true) {
      try {
        const upcomingPatients = await Consultation.find({
          doctor: doctor._id,
          status: { $in: ['scheduled', 'confirmed', 'pending'] },
          appointmentTime: { $gte: new Date(), $lte: new Date(Date.now() + 60 * 60 * 1000) },
        }).select('patient appointmentTime roomId').lean();

        for (const consultation of upcomingPatients.slice(0, 10)) {
          await notifyUser({
            userId: consultation.patient,
            type: 'consultation_started',
            title: 'Doctor is online',
            body: 'Your doctor is online and available now.',
            balancedTitle: 'Doctor online',
            balancedBody: 'Your doctor is available now.',
            genericTitle: 'You have a new update in Qureo',
            genericBody: 'Open Qureo to join your consultation.',
            route: '/doctor-consult',
            data: {
              consultationId: String(consultation._id),
              roomId: String(consultation.roomId || ''),
              doctorId: String(doctor._id),
              event: 'doctor_online',
            },
          });
        }
      } catch (notifyError) {
        console.warn('[doctor] push failed after online update:', notifyError?.message || notifyError);
      }
    }

    res.json({ message: "Doctor updated", doctor });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});



module.exports = router;
