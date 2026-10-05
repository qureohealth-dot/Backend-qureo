const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  wallet: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { 
    type: String, 
    required: true 
  },
  amount: { type: Number, required: true },
  previousBalance: { type: Number, required: true },
  newBalance: { type: Number, required: true },
  stripePaymentIntentId: {
  type: String,
  unique: true,
  sparse: true
},
  dollrReferenceId: { type: String, unique: true, sparse: true },
  dollrSourceId: { type: String, default: null },
  dollrStatus: { type: String, default: null },
  mobileMoneyReferenceId: { type: String, unique: true, sparse: true },
  mobileMoneyProvider: { type: String, default: null },
  mobileMoneyStatus: { type: String, default: null },

  status: { 
    type: String, 
    enum: ['pending', 'completed', 'failed', 'cancelled'],
    default: 'pending' 
  },
  description: String,
  reference: { type: String, unique: true },
  refundOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', unique: true, sparse: true },
  earningFor: { type: mongoose.Schema.Types.ObjectId, ref: 'Consultation', unique: true, sparse: true },
  paymentMethod: { type: String, default: 'wallet' },
  serviceCategory: { type: String, default: 'other' },
  fundingSource: { type: String, default: 'walletBalance' },
  splitAllocation: {
    walletBalance: { type: Number, default: 0 },
    familySupport: { type: Number, default: 0 },
    employerSupport: { type: Number, default: 0 },
    donorVoucher: { type: Number, default: 0 },
    insuranceCoverage: { type: Number, default: 0 },
  },
  dependentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Dependent', default: null },
  provider: { type: mongoose.Schema.Types.ObjectId, ref: 'HealthcareProvider' },
  metadata: Object,
  createdAt: { type: Date, default: Date.now },
  completedAt: Date
});

module.exports = mongoose.model('Transaction', transactionSchema);