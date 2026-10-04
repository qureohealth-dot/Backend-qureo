const express = require("express");

const Booking = require("../models/BookingLabtest.js");
const LabTest = require("../models/LabTest.js");
const { notifyUser } = require('../utils/notifyUser');
const labProviderAuth = require("../middleware/labProviderAuth");
const router = express.Router();


// 🧍 USER: Create a new booking
router.post("/", async (req, res) => {
  try {
    const { user, tests, items, preferredDate, collectionMethod } = req.body;

    // Support both names
    const labTests = tests || items;
    if (!labTests || !Array.isArray(labTests) || labTests.length === 0) {
      return res.status(400).json({ success: false, message: "No lab tests provided." });
    }

    // Fetch details from LabTest collection
    const fullTests = [];
    let totalAmount = 0;

    for (const t of labTests) {
      const found = await LabTest.findById(t.testId);
      if (!found) continue;

      const fullTest = {
        testId: found._id,
        name: found.name,
        price: found.price,
        category: found.category,
        qty: t.qty || 1,
      };

      totalAmount += found.price * (t.qty || 1);
      fullTests.push(fullTest);
    }

    if (fullTests.length === 0) {
      return res.status(400).json({ success: false, message: "No valid tests found." });
    }

    const booking = new Booking({
      user,
      tests: fullTests,
      preferredDate,
      collectionMethod,
      totalAmount,
    });

    await booking.save();

    try {
      await notifyUser({
        userId: user,
        type: 'lab_booking_created',
        title: 'Lab test booked successfully',
        body: 'Your lab booking has been created in Qureo.',
        balancedTitle: 'Lab booking confirmed',
        balancedBody: 'Your lab test booking was successful.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to view your lab booking details.',
        route: '/lab-tests',
        data: {
          bookingId: String(booking._id),
          testCount: String(fullTests.length),
          preferredDate: String(preferredDate || ''),
        },
      });
    } catch (notifyError) {
      console.warn('[lab-bookings] push failed on booking create:', notifyError?.message || notifyError);
    }

    res.status(201).json({ success: true, booking });
  } catch (error) {
    console.error("Error creating booking:", error);
    res.status(500).json({ success: false, message: "Server Error", details: error.message });
  }
});



// 📜 USER: Get all bookings for a user
router.get("/user/:userId", async (req, res) => {
  try {
    const bookings = await Booking.find({ user: req.params.userId })
      .populate("user")
      .populate("assignedAttendant")
      .populate("tests.testId");

    res.json({ success: true, bookings });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch bookings" });
  }
});

router.get("/provider/mine", labProviderAuth, async (req, res) => {
  try {
    const providerTests = await LabTest.find({ provider: req.labProvider._id }).select("_id");
    if (providerTests.length === 0) return res.json({ success: true, bookings: [] });

    const bookings = await Booking.find({ "tests.testId": { $in: providerTests.map((test) => test._id) } })
      .populate("user", "email fullName")
      .populate("assignedAttendant")
      .populate("tests.testId");
    const providerTestIds = new Set(providerTests.map((test) => String(test._id)));
    const providerBookings = bookings.map((booking) => {
      booking.tests = booking.tests.filter((test) => {
        const testId = test.testId?._id || test.testId;
        return providerTestIds.has(String(testId));
      });
      return booking;
    });
    res.json({ success: true, bookings: providerBookings });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch provider bookings" });
  }
});


// 🧾 ADMIN: Get all bookings
router.get("/", async (req, res) => {
  try {
    const bookings = await Booking.find()
      .populate("user")
      .populate("assignedAttendant")
      .populate("tests.testId");
    res.json({ success: true, bookings });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch all bookings" });
  }
});


// 🧬 ADMIN: Update booking status
router.put("/:id/status", labProviderAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const allowedStatuses = ["pending", "sample_collected", "in_progress", "completed", "cancelled"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid booking status" });
    }

    const providerTestIds = await LabTest.find({ provider: req.labProvider._id }).distinct("_id");
    const booking = await Booking.findOne({
      _id: req.params.id,
      "tests.testId": { $in: providerTestIds },
    });
    if (!booking) return res.status(404).json({ success: false, message: "Order not found" });
    booking.status = status;
    await booking.save();

    // Non-blocking push to booking owner on status update
    try {
      if (booking?.user) {
        await notifyUser({
          userId: booking.user,
          type: 'lab_booking_status_updated',
          title: 'Lab booking status updated',
          body: `Your lab booking status is now "${status}".`,
          balancedTitle: 'Lab booking updated',
          balancedBody: 'Your lab booking status has changed.',
          genericTitle: 'You have a new update in Qureo',
          genericBody: 'Open Qureo to view your latest lab update.',
          route: '/notification',
          data: {
            bookingId: String(booking._id),
            status: String(status || ''),
          },
        });
      }
    } catch (notifyError) {
      console.warn('[lab-bookings] push failed on booking status update:', notifyError?.message || notifyError);
    }

    res.json({ success: true, booking });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update status" });
  }
});


// 🧫 ADMIN: Update specimen info for a test
router.put("/:bookingId/test/:testId/specimen", async (req, res) => {
  try {
    const { bookingId, testId } = req.params;
    const { specimen } = req.body; // collectedBy, collectedAt, condition, notes

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const test = booking.tests.find(
      (t) => t.testId.toString() === testId.toString()
    );
    if (!test) return res.status(404).json({ message: "Test not found in booking" });

    test.specimen = specimen;
    await booking.save();

    res.json({ success: true, booking });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update specimen" });
  }
});


// 📄 ADMIN: Upload result for a test
router.put("/:bookingId/test/:testId/result", labProviderAuth, async (req, res) => {
  const { bookingId, testId } = req.params;
  const { resultFile, remarks, status } = req.body.result; // resultFile = Cloudinary URL
  console.log(req.body);
  try {
    const booking = await Booking.findById(bookingId).populate("user");
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const test = booking.tests.id(testId); // Mongoose subdocument helper
    if (!test) return res.status(404).json({ message: "Test not found in booking" });
    const ownedTest = await LabTest.exists({ _id: test.testId, provider: req.labProvider._id });
    if (!ownedTest) return res.status(403).json({ message: "You can only update results for your lab products" });

    // Update test result
    test.result = {
      resultFile,          // Cloudinary URL
      remarks: remarks || "",
      status: status || "completed",
      uploadedBy: req.labProvider._id,
      uploadedAt: new Date(),
      releasedAt: new Date(),
    };

    // Also update the test status in the booking
    test.status = status || "completed";

    await booking.save();

    // Non-blocking push to booking owner when result status changes
    try {
      await notifyUser({
        userId: booking.user?._id || booking.user,
        type: 'lab_result_status_updated',
        title: 'Results are available',
        body: `Result for ${test.name || 'your lab test'} is now "${test.status}".`,
        balancedTitle: 'Lab result update',
        balancedBody: 'A lab test result has been updated.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to view your latest lab update.',
        route: '/notification',
        data: {
          bookingId: String(booking._id),
          testId: String(test._id),
          status: String(test.status || ''),
        },
      });
    } catch (notifyError) {
      console.warn('[lab-bookings] push failed on result update:', notifyError?.message || notifyError);
    }

   
    res.json({ success: true, message: "Result uploaded, status updated, and email sent", booking });
  } catch (err) {
    console.error("Error uploading result:", err);
    res.status(500).json({ success: false, message: "Failed to upload result" });
  }
});



// 👀 USER: View a single booking
router.get("/:id", async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id)
      .populate("user")
      .populate("assignedAttendant")
      .populate("tests.testId");

    if (!booking) return res.status(404).json({ message: "Booking not found" });

    res.json({ success: true, booking });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch booking" });
  }
});


module.exports = router;
