const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const pharmacySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    address: { type: String, required: true },
    city: { type: String, required: true },
    description: { type: String },
    logo: { type: String }, // profile picture URL

    // ✅ Authentication fields
    password: { type: String, required: true, minlength: 6 },
    confirmPassword: { type: String, required: true, minlength: 6, select: false },

    // ✅ Relations & ratings
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // optional if linked to a user
    rating: { type: Number, default: 0, min: 0, max: 5 },
    reviews: { type: Number, default: 0 },
    featured: { type: Boolean, default: false },
    verified: { type: Boolean, default: false },
    deliveryAvailable: { type: Boolean, default: true },
    categories: { type: [String], default: [] },

    // ✅ Admin moderation
    isSuspended: { type: Boolean, default: false },
    suspendedAt: { type: Date },
    suspendedReason: { type: String },
  },
  { timestamps: true }
);



// ✅ Hash password before saving
pharmacySchema.pre("save", async function (next) {
  // hash password only if modified or new
  if (!this.isModified("password")) return next();

  if (this.password !== this.confirmPassword) {
    throw new Error("Passwords do not match");
  }

  this.password = await bcrypt.hash(this.password, 10);
  this.confirmPassword = undefined; // don’t save confirmPassword in DB
  next();
});

// ✅ Compare password during login
pharmacySchema.methods.comparePassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// ✅ Keep rating in bounds
pharmacySchema.pre("save", function (next) {
  if (this.rating > 5) this.rating = 5;
  if (this.rating < 0) this.rating = 0;
  next();
});

module.exports = mongoose.model("Pharmacy", pharmacySchema);
