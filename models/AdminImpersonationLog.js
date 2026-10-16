const mongoose = require('mongoose');

const adminImpersonationLogSchema = new mongoose.Schema(
  {
    adminId: { type: String, required: true, index: true },
    targetType: { type: String, enum: ['user', 'doctor', 'pharmacy', 'lab', 'payment'], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    startedAt: { type: Date, default: Date.now, required: true },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('AdminImpersonationLog', adminImpersonationLogSchema);