const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['invite', 'clinical'],
      default: 'invite',
      index: true,
    },
    inviter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: function requiredForInvites() { return this.type === 'invite'; },
      index: true,
    },
    inviteeEmail: {
      type: String,
      required: function requiredForInvites() { return this.type === 'invite'; },
      lowercase: true,
      trim: true,
      index: true,
    },
    inviteCode: {
      type: String,
      required: function requiredForInvites() { return this.type === 'invite'; },
      index: true,
    },
    inviteLink: {
      type: String,
      required: function requiredForInvites() { return this.type === 'invite'; },
    },
    channel: {
      type: String,
      enum: ['email', 'share', 'copy', 'unknown'],
      default: 'email',
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'created', 'sent', 'appointment_scheduled', 'seen', 'completed', 'declined', 'expired'],
      default: function defaultReferralStatus() { return this.type === 'clinical' ? 'created' : 'pending'; },
      index: true,
    },
    patientName: { type: String, trim: true },
    patientEmail: { type: String, lowercase: true, trim: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    referringProviderName: { type: String, trim: true },
    receivingProviderName: { type: String, trim: true },
    clinicalReason: { type: String, trim: true },
    urgency: { type: String, enum: ['routine', 'soon', 'urgent', 'emergency'] },
    appointmentAt: { type: Date, default: null },
    supportingRecords: { type: [String], default: [] },
    outcome: { type: String, trim: true, default: '' },
    followUp: { type: String, trim: true, default: '' },
    followUpDueAt: { type: Date, default: null },
    createdBy: { type: String, default: '' },
    emailSent: {
      type: Boolean,
      default: false,
    },
    emailError: {
      type: String,
      default: '',
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

referralSchema.index({ inviter: 1, createdAt: -1 });

module.exports = mongoose.model('Referral', referralSchema);
