const mongoose = require('mongoose');

const pharmacyWalletTransactionSchema = new mongoose.Schema({
  pharmacy: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', required: true, index: true },
  wallet: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyWallet', required: true },
  sourceTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true, unique: true },
  type: { type: String, enum: ['sale'], default: 'sale' },
  amount: { type: Number, required: true, min: 0 },
  previousBalance: { type: Number, required: true },
  newBalance: { type: Number, required: true },
  currency: { type: String, default: 'USD' },
  status: { type: String, enum: ['completed'], default: 'completed' },
  paymentMethod: { type: String, default: 'Qureo-Wallet' },
  description: { type: String, default: 'Medicine sale' },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('PharmacyWalletTransaction', pharmacyWalletTransactionSchema);