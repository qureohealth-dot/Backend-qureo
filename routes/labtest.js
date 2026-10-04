const express = require("express");
const router = express.Router();
const LabTest = require("../models/LabTest"); // make sure path is correct
const labProviderAuth = require("../middleware/labProviderAuth");

// CREATE a new lab test
router.post("/", labProviderAuth, async (req, res) => {
  try {
    const {
      name,
      category,
      description,
      price,
      image,
      laboratory,
      ratings,
      reviews,
      preparation,
      sampleType,
      estimatedTime
    } = req.body;

    if (!name || !category || !price) {
      return res.status(400).json({ error: "Name, category, and price are required." });
    }

    const labTest = new LabTest({
      name,
      category,
      description,
      price,
      image,
      laboratory: req.labProvider.name,
      provider: req.labProvider._id,
      ratings: ratings || 0,
      reviews: reviews || [],
      preparation,
      sampleType,
      estimatedTime
    });

    const savedTest = await labTest.save();
    res.status(201).json({ success: true, test: savedTest });
  } catch (err) {
    console.error("LabTest create error:", err);
    res.status(500).json({ error: "Failed to create lab test", details: err.message });
  }
});

// List only the signed-in lab provider's products.
router.get("/mine", labProviderAuth, async (req, res) => {
  try {
    const tests = await LabTest.find({ provider: req.labProvider._id }).sort({ createdAt: -1 });
    res.json({ success: true, tests });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch provider lab tests" });
  }
});

// GET all lab tests
router.get("/", async (req, res) => {
  try {
    const tests = await LabTest.find().sort({ createdAt: -1 });
    res.json({ success: true, tests });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch lab tests" });
  }
});

// GET a single lab test by ObjectId; named routes such as /mine never match here.
router.get("/:id([0-9a-fA-F]{24})", async (req, res) => {
  try {
    const { id } = req.params;
    const test = await LabTest.findById(id).populate("reviews.user", "fullName name");
    if (!test) {
      return res.status(404).json({ error: "Lab test not found" });
    }
    res.json({ success: true, test });
  } catch (err) {
    console.error("LabTest fetch error:", err);
    res.status(500).json({ error: "Failed to fetch lab test", details: err.message });
  }
});

// POST a review/comment for a lab test
router.post("/:id/reviews", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, userName, comment, rating } = req.body;

    const test = await LabTest.findById(id);
    if (!test) {
      return res.status(404).json({ error: "Lab test not found" });
    }

    const review = {
      user: userId || null,
      userName: userName || "Anonymous",
      comment: comment || "",
      rating: rating || 0,
      date: new Date(),
    };

    test.reviews.push(review);

    const totalRating = test.reviews.reduce((sum, r) => sum + (r.rating || 0), 0);
    test.ratings = test.reviews.length > 0 ? totalRating / test.reviews.length : 0;

    await test.save();
    const updatedTest = await LabTest.findById(id).populate("reviews.user", "fullName name");
    res.status(201).json({ success: true, test: updatedTest, review });
  } catch (err) {
    console.error("LabTest review error:", err);
    res.status(500).json({ error: "Failed to add review", details: err.message });
  }
});

// DELETE a lab test by ID
router.delete("/:id", labProviderAuth, async (req, res) => {
  try {
    const deletedTest = await LabTest.findOneAndDelete({
      _id: req.params.id,
      provider: req.labProvider._id,
    });
    if (!deletedTest) {
      return res.status(404).json({ error: "Lab test not found" });
    }
    res.json({ success: true, message: "Lab test deleted successfully" });
  } catch (err) {
    console.error("LabTest delete error:", err);
    res.status(500).json({ error: "Failed to delete lab test", details: err.message });
  }
});

module.exports = router;
