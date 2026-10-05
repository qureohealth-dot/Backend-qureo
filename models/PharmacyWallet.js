const mongoose = require('mongoose');

const pharmacyWalletSchema = new mongoose.Schema({
  pharmacy: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', required: true, unique: true },
  balance: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'USD' },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  totalReceived: { type: Number, default: 0, min: 0 },
  totalPaidOut: { type: Number, default: 0, min: 0 },
  lastTransaction: Date,
}, { timestamps: true });

module.exports = mongoose.model('PharmacyWallet', pharmacyWalletSchema);