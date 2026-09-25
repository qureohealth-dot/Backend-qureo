const mongoose = require('mongoose');

const dosageSchema = new mongoose.Schema({
  time: { type: String, required: true }, // "08:00 AM", "02:00 PM"
  taken: { type: Boolean, default: false },
  takenAt: { type: Date }, // When the dose was actually taken
  skippedAt: { type: Date },
  snoozedUntil: { type: Date },
  notes: { type: String },
});

const userMedicationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    
    // Medicine information
    medicineName: { type: String, required: true },
    brandName: { type: String },
    genericName: { type: String },
    strength: { type: String }, // "500mg", "10ml"
    
    // Prescription details
    doctorName: { type: String },
    prescriptionDate: { type: Date },
    
    // Dosing schedule
    dosages: [dosageSchema], // Array of scheduled doses
    frequency: { type: String }, // "Once daily", "Twice daily", "Three times daily"
    duration: { type: String }, // "7 days", "30 days", "As needed"
    durationEndDate: { type: Date },
    timezone: { type: String, default: 'UTC' },
    
    // Additional info
    instructions: { type: String }, // "Take with food", "Take on empty stomach"
    sideEffects: { type: String },
    category: { type: String }, // "Antibiotic", "Pain Relief", etc.
    prescriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription' },
    
    // Status
    isActive: { type: Boolean, default: true },
    isCompleted: { type: Boolean, default: false },
    
    // Adherence tracking
    adherencePercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    missedDoses: { type: Number, default: 0 },
    completedDoses: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Index for efficient queries
userMedicationSchema.index({ user: 1, isActive: 1 });
userMedicationSchema.index({ user: 1, createdAt: -1 });
userMedicationSchema.index(
  { durationEndDate: 1 },
  {
    expireAfterSeconds: 0,
    partialFilterExpression: { durationEndDate: { $type: 'date' } },
  }
);

// Calculate adherence percentage
userMedicationSchema.methods.calculateAdherence = function () {
  if (!this.dosages || this.dosages.length === 0) return 0;
  const taken = this.dosages.filter(d => d.taken).length;
  this.adherencePercentage = Math.round((taken / this.dosages.length) * 100);
  return this.adherencePercentage;
};

module.exports = mongoose.model('UserMedication', userMedicationSchema);
