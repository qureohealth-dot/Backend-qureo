const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');

async function refundConsultationPayment({ consultation, payment, reason = 'Doctor unavailable' }) {
  if (!payment || payment.status !== 'completed') return 'unavailable';
  if (payment.type !== 'consultation' || Number(payment.amount) <= 0) {
    throw new Error('Original consultation payment is not refundable');
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const confirmedPayment = await Transaction.findOne({
      _id: payment._id,
      user: consultation.patient,
      status: 'completed',
      type: 'consultation',
    }).session(session);
    if (!confirmedPayment) throw new Error('Original consultation payment is not refundable');

    const existingRefund = await Transaction.findOne({ refundOf: confirmedPayment._id }).session(session);
    if (existingRefund) {
      consultation.status = 'cancelled';
      consultation.rejectionReason = String(reason || 'Doctor unavailable').trim().slice(0, 500);
      consultation.refundStatus = 'completed';
      consultation.updatedAt = new Date();
      await consultation.save({ session });
      await session.commitTransaction();
      return 'completed';
    }

    const [patientWallet, escrowWallet] = await Promise.all([
      Wallet.findOneAndUpdate(
        { user: confirmedPayment.user },
        { $setOnInsert: { balance: 0, currency: 'USD', status: 'active' } },
        { upsert: true, new: true, setDefaultsOnInsert: true, session }
      ),
      confirmedPayment.provider
        ? Wallet.findOneAndUpdate(
            { user: confirmedPayment.provider },
            { $setOnInsert: { balance: 0, currency: 'USD', status: 'active' } },
            { upsert: true, new: true, setDefaultsOnInsert: true, session }
          )
        : null,
    ]);

    if (!patientWallet) throw new Error('Patient wallet not found for consultation refund');

    const amount = Number(confirmedPayment.amount);
    const patientPreviousBalance = Number(patientWallet.balance || 0);
    patientWallet.balance = patientPreviousBalance + amount;
    patientWallet.totalDeposits = Number(patientWallet.totalDeposits || 0) + amount;
    patientWallet.lastTransaction = new Date();
    const walletUpdates = [patientWallet.save({ session })];

    if (escrowWallet) {
      escrowWallet.balance = Number(escrowWallet.balance || 0) - amount;
      escrowWallet.totalWithdrawals = Number(escrowWallet.totalWithdrawals || 0) + amount;
      escrowWallet.lastTransaction = new Date();
      walletUpdates.push(escrowWallet.save({ session }));
    }

    await Promise.all(walletUpdates);
    await Transaction.create([{
      wallet: patientWallet._id,
      user: confirmedPayment.user,
      provider: confirmedPayment.provider,
      type: 'refund',
      amount,
      previousBalance: patientPreviousBalance,
      newBalance: patientWallet.balance,
      status: 'completed',
      paymentMethod: 'wallet',
      description: `Refund for rejected consultation ${consultation._id}`,
      reference: `CONSULTATION-REFUND-${confirmedPayment._id}`,
      refundOf: confirmedPayment._id,
      metadata: { consultationId: String(consultation._id) },
      completedAt: new Date(),
    }], { session });

    consultation.status = 'cancelled';
    consultation.rejectionReason = String(reason || 'Doctor unavailable').trim().slice(0, 500);
    consultation.refundStatus = 'completed';
    consultation.updatedAt = new Date();
    await consultation.save({ session });
    await session.commitTransaction();
    return 'completed';
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
}

module.exports = { refundConsultationPayment };