const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const { notifyUser } = require('../utils/notifyUser');

async function creditSuccessfulStripePayment(paymentIntent) {
  if (!paymentIntent?.id || paymentIntent.status !== 'succeeded') {
    throw new Error('A succeeded Stripe PaymentIntent is required');
  }

  const userId = paymentIntent.metadata?.userId;
  const amount = Number(paymentIntent.amount) / 100;
  if (!userId || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('Stripe PaymentIntent is missing valid wallet funding details');
  }

  const existing = await Transaction.findOne({ stripePaymentIntentId: paymentIntent.id }).lean();
  if (existing) return { credited: false, transaction: existing };

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const alreadyCredited = await Transaction.findOne({ stripePaymentIntentId: paymentIntent.id }).session(session);
    if (alreadyCredited) {
      await session.commitTransaction();
      return { credited: false, transaction: alreadyCredited };
    }

    let wallet = await Wallet.findOne({ user: userId }).session(session);
    if (!wallet) {
      wallet = new Wallet({ user: userId, balance: 0, currency: 'USD', totalDeposits: 0 });
    }

    const previousBalance = Number(wallet.balance || 0);
    wallet.balance = previousBalance + amount;
    wallet.totalDeposits = Number(wallet.totalDeposits || 0) + amount;
    wallet.lastTransaction = new Date();
    await wallet.save({ session });

    const transaction = new Transaction({
      wallet: wallet._id,
      user: userId,
      type: 'deposit',
      amount,
      previousBalance,
      newBalance: wallet.balance,
      status: 'completed',
      paymentMethod: 'stripe',
      stripePaymentIntentId: paymentIntent.id,
      description: `Stripe deposit of $${amount}`,
      reference: `STRIPE-${paymentIntent.id}`,
      completedAt: new Date(),
    });
    await transaction.save({ session });
    await session.commitTransaction();

    try {
      await notifyUser({
        userId,
        type: 'wallet_funded',
        title: 'Wallet funded successfully',
        body: `Your wallet was funded with $${amount.toFixed(2)}.`,
        balancedTitle: 'Wallet funded',
        balancedBody: 'Your wallet balance was increased.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to view your wallet update.',
        route: '/health-wallet',
        data: {
          transactionId: String(transaction._id),
          amount: amount.toFixed(2),
          paymentMethod: 'stripe',
        },
      });
    } catch (notificationError) {
      console.warn('[wallet] Stripe funding push failed:', notificationError?.message || notificationError);
    }

    return { credited: true, transaction, wallet };
  } catch (error) {
    await session.abortTransaction();
    if (error?.code === 11000) {
      const existingTransaction = await Transaction.findOne({ stripePaymentIntentId: paymentIntent.id }).lean();
      if (existingTransaction) return { credited: false, transaction: existingTransaction };
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

module.exports = { creditSuccessfulStripePayment };