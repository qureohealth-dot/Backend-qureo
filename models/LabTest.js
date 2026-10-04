const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  userName: { type: String, default: "Anonymous" },
  comment: String,
  rating: Number,
  date: { type: Date, default: Date.now }
});

const labTestSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, required: true },
  description: String,
  price: { type: Number, required: true },
  image: String,
  laboratory: String,
  provider: { type: mongoose.Schema.Types.ObjectId, ref: "Provider", default: null, index: true },
  ratings: { type: Number, default: 0 },
  reviews: [reviewSchema],
  preparation: String,
  sampleType: String,
  estimatedTime: String,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("LabTest", labTestSchema);
