const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const HealthcareProvider = require('../models/HealthcareProvider');
const User = require('../models/User');
const Profile = require('../models/Profile');
const InsuranceSubscription = require('../models/InsuranceSubscription');
const Stripe = require("stripe")
const Provider = require("../models/Provider")
const Dependent = require('../models/Dependent');
const DonorVoucher = require('../models/DonorVoucher');
const { notifyUser } = require('../utils/notifyUser');
const { randomUUID } = require('crypto');
const { createCollection, getCollectionStatus } = require('../services/dollr');


const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const APPROVED_SERVICE_CATEGORIES = new Set([
  'consultation',
  'medicine',
  'lab_test',
  'emergency_transport',
  'remote_monitoring',
  'health_records',
  'preventive_care',
  'follow_up',
  'insurance_premium',
]);

const SERVICE_TYPE_ALIASES = {
  medicine: 'medicine_refill',
  follow_up: 'consultation',
};

const COVERAGE_PRICE_BOOK = {
  consultation: 35,
  medicine_refill: 18,
  lab_test: 60,
  emergency_transport: 120,
};

const SOURCE_TO_BUCKET = {
  wallet_balance: 'walletBalance',
  mobile_money: 'mobileMoney',
  card: 'card',
  bank_transfer: 'bankTransfer',
  employer_contribution: 'employerSupport',
  donor_voucher: 'donorVoucher',
  family_support: 'familySupport',
};

const normalizeVoucherCode = (value) => String(value || '').trim().toUpperCase();
const normalizeSupportCategories = (categories = []) => {
  const list = Array.isArray(categories) ? categories : [];
  const normalized = list
    .map((category) => String(category || '').toLowerCase().trim())
    .filter((category) => APPROVED_SERVICE_CATEGORIES.has(category));

  return [...new Set(normalized)];
};

const PERSONAL_ALLOWANCE_BUCKET_ORDER = [
  'walletBalance',
  'mobileMoney',
  'card',
  'bankTransfer',
];

const reserveSponsorAllowanceFunds = (wallet, amount) => {
  let remaining = Number(amount || 0);
  const totalAvailable = PERSONAL_ALLOWANCE_BUCKET_ORDER.reduce(
    (sum, bucket) => sum + Number(wallet.reservedFunds?.[bucket] || 0),
    0
  );

  if (totalAvailable < remaining) {
    return false;
  }

  PERSONAL_ALLOWANCE_BUCKET_ORDER.forEach((bucket) => {
    if (remaining <= 0) return;
    const current = Number(wallet.reservedFunds?.[bucket] || 0);
    const used = Math.min(current, remaining);
    wallet.reservedFunds[bucket] = current - used;
    remaining -= used;
  });

  wallet.reservedFunds.familySupport = Number(wallet.reservedFunds?.familySupport || 0) + Number(amount || 0);
  return true;
};

const isVoucherAdminRequest = (req) => {
  const configuredKey = process.env.WALLET_VOUCHER_ADMIN_KEY;
  if (!configuredKey) return false;
  const requestKey = req.headers['x-voucher-admin-key'] || req.body?.adminKey;
  return requestKey && String(requestKey) === String(configuredKey);
};

const ensureWallet = async (userId, session = null) => {
  const query = Wallet.findOne({ user: userId });
  if (session) query.session(session);

  let wallet = await query;
  if (!wallet) {
    wallet = new Wallet({
      user: userId,
      balance: 0,
      currency: 'USD',
      reservedFunds: {
        walletBalance: 0,
        familySupport: 0,
        employerSupport: 0,
        donorVoucher: 0,
        mobileMoney: 0,
        card: 0,
        bankTransfer: 0,
      },
    });
    await wallet.save(session ? { session } : undefined);
  }

  return wallet;
};
// Get wallet balance (POST with userId in body)
router.get("/list-of-wallets", async (req, res) => {
  try {
    const wallets = await Wallet.find({});  
    res.json({ success: true, wallets });
    } catch (error) {
    res.status(500).json({ error: error.message });
    }   
});

/*


router.post('/webhook',
  express.raw({ type: 'application/json' }),
 
  async (req, res) => {
 console.log("being called")
    const sig = req.headers['stripe-signature'];
    let event;

    console.log(sig, "sig")
  
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET

      );

      
    } catch (err) {
      console.log(err.message)
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

      console.log(event, "event")
    if (event.type === 'payment_intent.succeeded') {

      const paymentIntent = event.data.object;
      const userId = paymentIntent.metadata.userId;
      const amount = paymentIntent.amount / 100;
      console.log("payment succeed")
      // 🔥 Prevent duplicate credits
      const existingTransaction = await Transaction.findOne({
        stripePaymentIntentId: paymentIntent.id
      });

      if (existingTransaction) {
        return res.json({ received: true });
      }

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        let wallet = await Wallet.findOne({ user: userId }).session(session);

        if (!wallet) {
          wallet = new Wallet({
            user: userId,
            balance: 0,
            currency: 'USD',
            totalDeposits: 0
          });
        }

        const previousBalance = wallet.balance;
        const newBalance = previousBalance + amount;

        wallet.balance = newBalance;
        wallet.totalDeposits += amount;
        wallet.lastTransaction = new Date();
        await wallet.save({ session });

        const transaction = new Transaction({
          wallet: wallet._id,
          user: userId,
          type: 'deposit',
          amount,
          previousBalance,
          newBalance,
          status: 'completed',
          paymentMethod: 'stripe',
          stripePaymentIntentId: paymentIntent.id, // 🔐 critical
          description: `Stripe deposit of $${amount}`,
          reference: `STRIPE-${paymentIntent.id}`,
          completedAt: new Date()
        });

        await transaction.save({ session });

        await session.commitTransaction();
        session.endSession();

      } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error(error);
      }
    }

    res.json({ received: true });
});

*/

// JSON AFTER webhook
router.use(express.json());

/**
 * Create PaymentIntent
 */


router.post("/api/create-payment-intent", async (req, res) => {
  try {
    const { amount, userId } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: "usd",
      automatic_payment_methods: { enabled: true },
      metadata: {
        userId,
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



router.post('/balance', async (req, res) => {
  try {
    const  userId  = req.query.user;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    let wallet = await Wallet.findOne({ user: userId });

    if (!wallet) {
      wallet = new Wallet({
        user: userId,
        balance: 0, // Starting balance
        currency: 'USD'
      });
      await wallet.save();
    }

    res.json({
      success: true,
      balance: wallet.balance,
      currency: wallet.currency,
      status: wallet.status,
      lastTransaction: wallet.lastTransaction
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/all-transactions", async (req, res) => {
  try {
    const transactions = await Transaction.find({});    
    res.json({ success: true, transactions });
    } catch (error) {
    res.status(500).json({ error: error.message });
    }
});

router.get("/transaction-wallet/:providerId", async (req, res) => {
  try {
    const { providerId } = req.params;

    if (!providerId) {
      return res.status(400).json({ error: "Provider ID is required" });
    }

    const transactions = await Transaction.find({ provider: providerId })
      .sort({ createdAt: -1 }) // newest first
      .populate("user", "name email") // optional
      .populate("provider", "email type"); // optional

    res.json({
      success: true,
      count: transactions.length,
      transactions
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Get transactions (POST with userId in body)
router.post('/transactions', async (req, res) => {
    console.log(req.body.userId, "transaction userId");
  try {
    const { userId, limit = 10, page = 1 } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const skip = (page - 1) * limit;

    const transactions = await Transaction.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('provider', 'name type icon');

      

    const total = await Transaction.countDocuments({ user: userId });

    console.log({
      success: true,
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    
})
    res.json({
      success: true,
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



//External Transfer
router.post("/top-up", async (req, res) => {
  console.log("being called");

  const session = await Wallet.startSession();
  session.startTransaction();
  // Accept the legacy wrapped body and the direct form body.
  const body = req.body.data || req.body || {};
  try {
    const receiverId = body.receiverId || body.reciverId;
    const { amount, senderName, senderContact, paymentMethod = 'external_transfer' } = body;
    if (!receiverId || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    let wallet = await Wallet.findOne({ user: receiverId }).session(session);
    if (!wallet) {
      wallet = new Wallet({ user: receiverId, balance: 0 });
    }

    const previousBalance = wallet.balance;
    const newBalance = previousBalance + parseFloat(amount);

    wallet.balance = newBalance;
    wallet.totalDeposits += parseFloat(amount);
    wallet.lastTransaction = new Date();
    await wallet.save({ session });

    const transaction = new Transaction({
      wallet: wallet._id,
      user: receiverId,
      type: "deposit",
      amount: parseFloat(amount),
      previousBalance,
      newBalance,
      status: "completed",
      paymentMethod,
      description: `Deposit of ₦${amount} from ${senderName || "Unknown"}`,
      reference: `DEP-${Date.now()}`,
      completedAt: new Date(),
    });
    await transaction.save({ session });

    await session.commitTransaction();
    session.endSession();

    try {
      await notifyUser({
        userId: receiverId,
        type: 'wallet_funded',
        title: 'Wallet funded successfully',
        body: `Your wallet received ${amount}.`,
        balancedTitle: 'Wallet funded',
        balancedBody: 'Your wallet balance was increased.',
        genericTitle: 'You have a new update in Qureo',
        genericBody: 'Open Qureo to view your wallet update.',
        route: '/health-wallet',
        data: {
          transactionId: String(transaction._id),
          amount: String(amount),
          senderName: String(senderName || ''),
        },
      });
    } catch (notifyError) {
      console.warn('[wallet] push failed after top-up:', notifyError?.message || notifyError);
    }

    // ✅ Send a proper response back
    return res.status(200).json({
      success: true,
      message: "Wallet top-up successful",
      data: {
        walletBalance: wallet.balance,
        transactionId: transaction._id,
      },
    });
  } catch (error) {
    console.error("Top-up error:", error);
    await session.abortTransaction();
    session.endSession();

    // ❌ Always send an error response too
    return res.status(500).json({
      success: false,
      message: "An error occurred during wallet top-up",
      error: error.message,
    });
  }
});


// Add money to wallet
// This should ONLY create Stripe PaymentIntent
router.post('/deposit', async (req, res) => {
  try {
    const { userId, amount } = req.body;

    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      metadata: { userId },
      automatic_payment_methods: { enabled: true }
    });

    res.json({
      clientSecret: paymentIntent.client_secret
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Withdraw money
router.post('/withdraw', async (req, res) => {
  try {
    const { userId, amount, withdrawalMethod } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const wallet = await Wallet.findOne({ user: userId }).session(session);
      if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
      if (wallet.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

      const previousBalance = wallet.balance;
      const newBalance = previousBalance - parseFloat(amount);

      wallet.balance = newBalance;
      wallet.totalWithdrawals += parseFloat(amount);
      wallet.lastTransaction = new Date();
      await wallet.save({ session });

      const transaction = new Transaction({
        wallet: wallet._id,
        user: userId,
        type: 'withdrawal',
        amount: parseFloat(amount),
        previousBalance,
        newBalance,
        status: 'pending',
        paymentMethod: withdrawalMethod || 'bank_transfer',
        description: `Withdrawal of $${amount}`,
        reference: `WITH-${Date.now()}`
      });
      await transaction.save({ session });

      await session.commitTransaction();
      session.endSession();

      setTimeout(async () => {
        transaction.status = 'completed';
        transaction.completedAt = new Date();
        await transaction.save();
      }, 2000);

      res.json({
        success: true,
        message: 'Withdrawal initiated',
        newBalance,
        transactionId: transaction._id,
        estimatedCompletion: '24 hours'
      });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



// Pay provider
router.post('/pay-provider', async (req, res) => {
  try {
    const { userId, providerId, amount, serviceDetails, type, dependentId = null } = req.body;

    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!providerId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Provider ID and valid amount required' });
    }

    const provider = await Provider.findById(providerId);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // 1️⃣ Get user wallet
      const wallet = await Wallet.findOne({ user: userId }).session(session);
      if (!wallet) throw new Error('User wallet not found');

      let dependent = null;
      let dependentAllocation = null;
      if (dependentId) {
        dependent = await Dependent.findOne({ _id: dependentId, owner: userId, active: true }).session(session);
        if (!dependent) throw new Error('Selected dependent is invalid');
        dependentAllocation = (wallet.dependentSupportAllocations || []).find(
          (allocation) => String(allocation.dependentId) === String(dependentId) && allocation.active
        );
        if (!dependentAllocation || Number(dependentAllocation.availableAmount || 0) < Number(amount)) {
          throw new Error('Insufficient dependent wallet balance');
        }
      }

      if (wallet.balance < amount) {
        throw new Error('Insufficient balance');
      }

      const previousBalance = wallet.balance;
      const newBalance = previousBalance - parseFloat(amount);

      wallet.balance = newBalance;
      if (dependentAllocation) {
        dependentAllocation.availableAmount = Number(dependentAllocation.availableAmount || 0) - Number(amount);
        wallet.reservedFunds.familySupport = Math.max(0, Number(wallet.reservedFunds.familySupport || 0) - Number(amount));
      }
      wallet.lastTransaction = new Date();
      await wallet.save({ session });

      // 2️⃣ Get provider wallet
      const wallet2 = await Wallet.findOne({ user: providerId }).session(session);

      if (!wallet2) throw new Error('Provider wallet not found');

      const providerPreviousBalance = wallet2.balance;
      const providerNewBalance = providerPreviousBalance + parseFloat(amount);

      wallet2.balance = providerNewBalance;
      wallet2.lastTransaction = new Date();
      await wallet2.save({ session });

      // 3️⃣ Save transaction
      const transaction = new Transaction({
        wallet: wallet._id,
        user: userId,
        provider: providerId,
        type,
        amount: parseFloat(amount),
        previousBalance,
        newBalance,
        status: 'completed',
        paymentMethod: 'wallet',
        dependentId,
        description: serviceDetails || 'healthcare service',
        reference: `PAY-${Date.now()}`,
        metadata: { serviceDetails, walletSource: dependent ? `dependent:${dependent._id}` : 'health' },
        completedAt: new Date()
      });

      await transaction.save({ session });

      await session.commitTransaction();
      session.endSession();

      // Non-blocking push notification to payer
      try {
        const providerName = provider?.name || provider?.email || 'provider';
        await notifyUser({
          userId,
          type: 'wallet_payment_completed',
          title: 'Payment completed',
          body: `You paid $${Number(amount).toFixed(2)} to ${providerName}.`,
          balancedTitle: 'Payment completed',
          balancedBody: 'Your wallet payment was completed successfully. Check your wallet balance and Notification. THANKS.',
          genericTitle: 'You have a new update in Qureo',
          genericBody: 'Open Qureo to view your wallet update.',
          route: '/health-wallet',
          data: {
            transactionId: String(transaction._id),
            providerId: String(providerId),
            amount: String(Number(amount).toFixed(2)),
          },
        });
      } catch (notifyError) {
        console.warn('[wallet] push notification failed after payment:', notifyError?.message || notifyError);
      }

      res.json({
        success: true,
        message: `Payment to ${provider.email} successful`,
        newBalance,
        transactionId: transaction._id
      });

    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      res.status(400).json({ error: error.message });
    }

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get transaction details (POST with userId in body)
router.post('/transactions/:id', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const transaction = await Transaction.findOne({
      _id: req.params.id,
      user: userId
    }).populate('provider', 'name type address contactPhone');

    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

    res.json({ success: true, transaction });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add funds from explicit healthcare funding sources
router.post('/funding-source/add', async (req, res) => {
  try {
    const { userId, amount, sourceType = 'wallet_balance', sourceLabel = '', sourceContext = {} } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const normalizedSource = String(sourceType).toLowerCase();

router.get('/funding-source/status/:referenceId', async (req, res) => {
  const { referenceId } = req.params;
  const { userId } = req.query;
  if (!referenceId || !userId) {
    return res.status(400).json({ error: 'referenceId and userId are required' });
  }

  try {
    const transaction = await Transaction.findOne({ dollrReferenceId: referenceId, user: userId });
    if (!transaction) return res.status(404).json({ error: 'Funding transaction not found' });

    const dollrResponse = await getCollectionStatus(referenceId);
    const dollrStatus = String(
      dollrResponse?.status || dollrResponse?.data?.status || 'PROCESSING'
    ).toUpperCase();

    if (dollrStatus === 'COMPLETED' && transaction.status !== 'completed') {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const lockedTransaction = await Transaction.findOne({
          _id: transaction._id,
          status: { $ne: 'completed' },
        }).session(session);
        if (lockedTransaction) {
          const wallet = await ensureWallet(userId, session);
          const fundingAmount = Number(lockedTransaction.amount);
          const previousBalance = Number(wallet.balance || 0);
          wallet.balance = previousBalance + fundingAmount;
          wallet.totalDeposits = Number(wallet.totalDeposits || 0) + fundingAmount;
          wallet.lastTransaction = new Date();
          wallet.reservedFunds.mobileMoney = Number(wallet.reservedFunds?.mobileMoney || 0) + fundingAmount;
          await wallet.save({ session });

          lockedTransaction.previousBalance = previousBalance;
          lockedTransaction.newBalance = wallet.balance;
          lockedTransaction.status = 'completed';
          lockedTransaction.dollrStatus = dollrStatus;
          lockedTransaction.completedAt = new Date();
          await lockedTransaction.save({ session });
        }
        await session.commitTransaction();
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        session.endSession();
      }
    } else if (dollrStatus === 'FAILED' || dollrStatus === 'CANCELED' || dollrStatus === 'CANCELLED') {
      await Transaction.updateOne(
        { _id: transaction._id, status: { $ne: 'completed' } },
        { $set: { status: 'failed', dollrStatus } }
      );
    } else if (transaction.dollrStatus !== dollrStatus) {
      await Transaction.updateOne({ _id: transaction._id }, { $set: { dollrStatus } });
    }

    const current = await Transaction.findById(transaction._id).select('status dollrStatus amount newBalance');
    return res.json({
      success: true,
      status: current.dollrStatus || dollrStatus,
      transactionStatus: current.status,
      amount: current.amount,
      walletBalance: current.newBalance,
    });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});
    const bucketKey = SOURCE_TO_BUCKET[normalizedSource];
    if (!bucketKey) {
      return res.status(400).json({ error: 'Unsupported sourceType' });
    }

    if (normalizedSource === 'mobile_money') {
      const sourcePhone = String(sourceContext?.phoneNumber || '').replace(/\s+/g, '');
      const network = String(sourceContext?.network || '').toUpperCase();
      const providerMap = {
        MTN: { provider: process.env.DOLLR_MOBILE_MONEY_PROVIDER || 'PAWAPAY', method: process.env.DOLLR_MTN_METHOD || 'MTN_MOMO_LBR', countryCode: process.env.DOLLR_COUNTRY_CODE || 'LR' },
        ORANGE: { provider: process.env.DOLLR_MOBILE_MONEY_PROVIDER || 'PAWAPAY', method: process.env.DOLLR_ORANGE_METHOD || 'ORANGE_MONEY_LBR', countryCode: process.env.DOLLR_COUNTRY_CODE || 'LR' },
      };
      const networkConfig = providerMap[network];
      if (!sourcePhone || !networkConfig) {
        return res.status(400).json({ error: 'A valid mobile number and supported network are required' });
      }

      const user = await User.findById(userId).select('fullName email');
      if (!user) return res.status(404).json({ error: 'User not found' });

      const wallet = await ensureWallet(userId);
      const referenceId = randomUUID();
      const fundingAmount = Number(amount);
      const transaction = await Transaction.create({
        wallet: wallet._id,
        user: userId,
        type: 'care_fund_addition',
        amount: fundingAmount,
        previousBalance: wallet.balance,
        newBalance: wallet.balance,
        status: 'pending',
        paymentMethod: 'mobile_money',
        fundingSource: bucketKey,
        reference: referenceId,
        dollrReferenceId: referenceId,
        metadata: { sourceType: normalizedSource, sourceLabel, sourceContext },
      });

      try {
        const collection = await createCollection({
          fullName: user.fullName || user.email,
          email: user.email,
          phone: sourcePhone,
          countryCode: networkConfig.countryCode,
          amount: fundingAmount,
          currency: wallet.currency || process.env.DOLLR_CURRENCY || 'USD',
          provider: networkConfig.provider,
          method: networkConfig.method,
          referenceId,
        });
        transaction.dollrSourceId = collection.invoiceId;
        transaction.dollrStatus = collection.execution?.status || 'PENDING';
        transaction.metadata = { ...transaction.metadata, dollr: collection };
        await transaction.save();
        return res.status(202).json({
          success: true,
          message: 'Mobile-money collection initiated. Approve it on your phone.',
          status: transaction.dollrStatus,
          referenceId,
          transactionId: transaction._id,
        });
      } catch (error) {
        transaction.status = 'failed';
        transaction.dollrStatus = 'FAILED';
        transaction.metadata = { ...transaction.metadata, error: error.message };
        await transaction.save();
        throw error;
      }
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const wallet = await ensureWallet(userId, session);
      const fundingAmount = Number(amount);

      let resolvedSourceLabel = sourceLabel || normalizedSource;

      if (normalizedSource === 'family_support') {
        const dependentId = sourceContext?.dependentId;
        if (!dependentId) {
          throw new Error('Family support requires a linked dependent in-app');
        }

        const dependent = await Dependent.findOne({ _id: dependentId, owner: userId, active: true }).session(session);
        if (!dependent) {
          throw new Error('Selected dependent is invalid');
        }

        const allowedServiceCategories = normalizeSupportCategories(sourceContext?.allowedServiceCategories);
        if (allowedServiceCategories.length === 0) {
          throw new Error('Family support must allow at least one care service category');
        }
        const allocationIndex = Array.isArray(wallet.dependentSupportAllocations)
          ? wallet.dependentSupportAllocations.findIndex(
              (allocation) => String(allocation.dependentId) === String(dependentId) && allocation.active
            )
          : -1;

        const allocationPayload = {
          dependentId: dependent._id,
          sponsorName: String(sourceContext?.sponsorName || '').trim(),
          sponsorPhone: String(sourceContext?.sponsorPhone || '').trim(),
          reference: String(sourceContext?.reference || '').trim(),
          availableAmount: fundingAmount,
          allowedServiceCategories,
          active: true,
          updatedAt: new Date(),
        };

        if (allocationIndex >= 0) {
          const existingAllocation = wallet.dependentSupportAllocations[allocationIndex];
          existingAllocation.availableAmount = Number(existingAllocation.availableAmount || 0) + fundingAmount;
          existingAllocation.sponsorName = allocationPayload.sponsorName || existingAllocation.sponsorName;
          existingAllocation.sponsorPhone = allocationPayload.sponsorPhone || existingAllocation.sponsorPhone;
          existingAllocation.reference = allocationPayload.reference || existingAllocation.reference;
          existingAllocation.allowedServiceCategories = allowedServiceCategories;
          existingAllocation.updatedAt = new Date();
        } else {
          if (!Array.isArray(wallet.dependentSupportAllocations)) {
            wallet.dependentSupportAllocations = [];
          }
          wallet.dependentSupportAllocations.push(allocationPayload);
        }

        resolvedSourceLabel = `Family support - ${dependent.fullName}`;
      }

      if (normalizedSource === 'employer_contribution') {
        const employerProfileId = String(sourceContext?.employerProfileId || '');
        const employerProfiles = Array.isArray(wallet.fundingProfiles?.employerSupport)
          ? wallet.fundingProfiles.employerSupport
          : [];
        const employerProfile = employerProfiles.find((profile) => String(profile._id) === employerProfileId && profile.active);

        if (!employerProfile) {
          throw new Error('Employer support requires a saved employer profile');
        }

        resolvedSourceLabel = `Employer support - ${employerProfile.name}${employerProfile.staffId ? ` (${employerProfile.staffId})` : ''}`;
      }

      if (normalizedSource === 'donor_voucher') {
        const voucherCode = normalizeVoucherCode(sourceContext?.voucherCode);
        if (!voucherCode) {
          throw new Error('Donor voucher code is required');
        }

        const voucher = await DonorVoucher.findOne({
          code: voucherCode,
          assignedUser: userId,
          status: 'active',
          linkedToWallet: true,
        }).session(session);

        if (!voucher) {
          throw new Error('Voucher not found, not linked, or inactive');
        }

        if (voucher.expiresAt && new Date(voucher.expiresAt).getTime() < Date.now()) {
          voucher.status = 'expired';
          await voucher.save({ session });
          throw new Error('Voucher has expired');
        }

        if (Number(voucher.amountRemaining || 0) < fundingAmount) {
          throw new Error('Voucher balance is not enough for this amount');
        }

        voucher.amountRemaining = Number(voucher.amountRemaining || 0) - fundingAmount;
        if (voucher.amountRemaining <= 0) {
          voucher.amountRemaining = 0;
          voucher.status = 'exhausted';
        }

        await voucher.save({ session });

        resolvedSourceLabel = `Donor voucher - ${voucher.code}`;
      }

      const previousBalance = wallet.balance;
      const newBalance = previousBalance + fundingAmount;

      wallet.balance = newBalance;
      wallet.totalDeposits += fundingAmount;
      wallet.lastTransaction = new Date();
      wallet.reservedFunds[bucketKey] = Number(wallet.reservedFunds[bucketKey] || 0) + fundingAmount;

      await wallet.save({ session });

      const transaction = new Transaction({
        wallet: wallet._id,
        user: userId,
        type: 'care_fund_addition',
        amount: fundingAmount,
        previousBalance,
        newBalance,
        status: 'completed',
        paymentMethod: normalizedSource,
        fundingSource: bucketKey,
        description: `Added care funds via ${resolvedSourceLabel}`,
        reference: `FUND-${Date.now()}`,
        metadata: { sourceType: normalizedSource, sourceLabel: resolvedSourceLabel, sourceContext },
        completedAt: new Date(),
      });

      await transaction.save({ session });
      await session.commitTransaction();
      session.endSession();

      try {
        await notifyUser({
          userId,
          type: 'wallet_funded',
          title: 'Wallet funded successfully',
          body: `Your wallet was funded with $${Number(amount).toFixed(2)}.`,
          balancedTitle: 'Wallet funded',
          balancedBody: 'Your wallet balance was increased.',
          genericTitle: 'You have a new update in Qureo',
          genericBody: 'Open Qureo to view your wallet update.',
          route: '/health-wallet',
          data: {
            transactionId: String(transaction._id),
            amount: String(Number(amount).toFixed(2)),
            providerId: String(providerId),
          },
        });
      } catch (notifyError) {
        console.warn('[wallet] push failed after funding-source addition:', notifyError?.message || notifyError);
      }

      return res.json({
        success: true,
        message: 'Care funds added successfully',
        wallet: {
          balance: wallet.balance,
          reservedFunds: wallet.reservedFunds,
        },
        transactionId: transaction._id,
      });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/funding-source/context', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const wallet = await ensureWallet(userId);
    const dependents = await Dependent.find({ owner: userId, active: true })
      .sort({ createdAt: -1 })
      .select('_id fullName relationship');

    const employerProfiles = (wallet.fundingProfiles?.employerSupport || []).filter((profile) => profile.active);
    const supportAllocations = (wallet.dependentSupportAllocations || []).filter((allocation) => allocation.active);
    const donorVouchers = await DonorVoucher.find({
      assignedUser: userId,
      status: 'active',
      linkedToWallet: true,
    })
      .sort({ createdAt: -1 })
      .select('code sponsorName amountRemaining expiresAt');

    return res.json({
      success: true,
      context: {
        dependents,
        employerProfiles,
        supportAllocations,
        donorVouchers,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/funding-source/voucher/issue', async (req, res) => {
  try {
    if (!isVoucherAdminRequest(req)) {
      return res.status(403).json({ error: 'Only authorized admin issuers can create vouchers' });
    }

    const { recipientUserId, code, sponsorName = '', amount, expiresAt = null, issuedByUserId = null } = req.body;
    if (!recipientUserId) return res.status(400).json({ error: 'recipientUserId is required' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Voucher amount must be positive' });

    const recipient = await User.findById(recipientUserId).select('_id');
    if (!recipient) return res.status(404).json({ error: 'Recipient user not found' });

    let voucherCode = normalizeVoucherCode(code);
    if (!voucherCode) {
      voucherCode = `VCH-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    }

    const existing = await DonorVoucher.findOne({ code: voucherCode });
    if (existing) {
      return res.status(400).json({ error: 'Voucher code already exists' });
    }

    const voucher = await DonorVoucher.create({
      code: voucherCode,
      sponsorName: String(sponsorName || '').trim(),
      assignedUser: recipientUserId,
      issuedByUserId,
      totalAmount: Number(amount),
      amountRemaining: Number(amount),
      linkedToWallet: false,
      status: 'active',
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });

    return res.status(201).json({
      success: true,
      voucher: {
        _id: voucher._id,
        code: voucher.code,
        sponsorName: voucher.sponsorName,
        amountRemaining: voucher.amountRemaining,
        expiresAt: voucher.expiresAt,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/funding-source/employer/add', async (req, res) => {
  try {
    const { userId, name, staffId = '', reference = '' } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Employer name is required' });

    const wallet = await ensureWallet(userId);
    if (!wallet.fundingProfiles) wallet.fundingProfiles = {};
    if (!Array.isArray(wallet.fundingProfiles.employerSupport)) wallet.fundingProfiles.employerSupport = [];

    wallet.fundingProfiles.employerSupport.push({
      name: String(name).trim(),
      staffId: String(staffId || '').trim(),
      reference: String(reference || '').trim(),
      active: true,
    });

    await wallet.save();
    const employerProfiles = wallet.fundingProfiles.employerSupport.filter((profile) => profile.active);

    return res.status(201).json({ success: true, employerProfiles });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/funding-source/voucher/redeem', async (req, res) => {
  try {
    const { userId, code } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!code || !String(code).trim()) return res.status(400).json({ error: 'Voucher code is required' });

    const normalizedCode = normalizeVoucherCode(code);
    const voucher = await DonorVoucher.findOne({
      code: normalizedCode,
      assignedUser: userId,
      status: 'active',
    });

    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found for this account' });
    }

    if (voucher.expiresAt && new Date(voucher.expiresAt).getTime() < Date.now()) {
      voucher.status = 'expired';
      await voucher.save();
      return res.status(400).json({ error: 'Voucher has expired' });
    }

    if (Number(voucher.amountRemaining || 0) <= 0) {
      voucher.status = 'exhausted';
      voucher.amountRemaining = 0;
      await voucher.save();
      return res.status(400).json({ error: 'Voucher is exhausted' });
    }

    voucher.linkedToWallet = true;
    await voucher.save();

    const donorVouchers = await DonorVoucher.find({
      assignedUser: userId,
      status: 'active',
      linkedToWallet: true,
    })
      .sort({ createdAt: -1 })
      .select('code sponsorName amountRemaining expiresAt');

    return res.status(201).json({ success: true, donorVouchers });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Add a dependent under wallet owner
router.post('/dependents/add', async (req, res) => {
  try {
    const { userId, fullName, relationship = 'other', dateOfBirth = null, linkedAccountEmail = '' } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!fullName || !String(fullName).trim()) return res.status(400).json({ error: 'fullName is required' });

    const normalizedEmail = String(linkedAccountEmail || '').trim().toLowerCase();
    let linkedUser = null;
    let linkedAccountStatus = 'unlinked';
    let careAccessMode = 'sponsor_managed';

    if (normalizedEmail) {
      linkedUser = await User.findOne({ email: normalizedEmail }).select('_id');
      linkedAccountStatus = linkedUser ? 'linked' : 'pending';
      careAccessMode = linkedUser ? 'linked_wallet' : 'sponsor_managed';
    }

    const dependent = await Dependent.create({
      owner: userId,
      fullName: String(fullName).trim(),
      relationship,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
      linkedUser: linkedUser?._id || null,
      linkedAccountEmail: normalizedEmail,
      linkedAccountStatus,
      careAccessMode,
    });

    return res.status(201).json({
      success: true,
      message: 'Dependent added successfully',
      dependent,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/dependents', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    // A dependent can be added before they create their Qureo account. Resolve
    // those pending links every time the owner opens the wallet.
    const pendingDependents = await Dependent.find({
      owner: userId,
      active: true,
      linkedAccountStatus: 'pending',
      linkedAccountEmail: { $ne: '' },
    });
    for (const pending of pendingDependents) {
      const linkedUser = await User.findOne({ email: pending.linkedAccountEmail }).select('_id');
      if (linkedUser) {
        pending.linkedUser = linkedUser._id;
        pending.linkedAccountStatus = 'linked';
        pending.careAccessMode = 'linked_wallet';
        await pending.save();
      }
    }

    const dependents = await Dependent.find({ owner: userId, active: true })
      .sort({ createdAt: -1 })
      .populate('linkedUser', 'fullName email');
    return res.json({ success: true, dependents });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/dependents/linked-to-me', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const linkedDependents = await Dependent.find({ linkedUser: userId, active: true })
      .sort({ createdAt: -1 })
      .populate('owner', 'fullName email');

    const ownerIds = [...new Set(linkedDependents.map((entry) => String(entry.owner?._id || entry.owner)).filter(Boolean))];
    const ownerWallets = await Wallet.find({ user: { $in: ownerIds } }).select('user dependentSupportAllocations');
    const walletByOwner = new Map(ownerWallets.map((wallet) => [String(wallet.user), wallet]));

    const enriched = linkedDependents.map((entry) => {
      const ownerId = String(entry.owner?._id || entry.owner || '');
      const ownerWallet = walletByOwner.get(ownerId);
      const allocation = (ownerWallet?.dependentSupportAllocations || []).find(
        (item) => String(item.dependentId) === String(entry._id) && item.active
      );

      return {
        ...entry.toObject(),
        allowance: allocation
          ? {
              availableAmount: Number(allocation.availableAmount || 0),
              allowedServiceCategories: allocation.allowedServiceCategories || [],
              sponsorName: allocation.sponsorName || '',
              reference: allocation.reference || '',
            }
          : null,
      };
    });

    return res.json({ success: true, linkedDependents: enriched });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/dependents/:id/allowance', async (req, res) => {
  try {
    const { userId, amount, allowedServiceCategories = [], reference = '' } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Allowance amount must be greater than zero' });

    const dependent = await Dependent.findOne({ _id: req.params.id, owner: userId, active: true });
    if (!dependent) return res.status(404).json({ error: 'Dependent not found' });

    const normalizedCategories = normalizeSupportCategories(allowedServiceCategories);
    if (normalizedCategories.length === 0) {
      return res.status(400).json({ error: 'Select at least one allowed care category' });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const wallet = await ensureWallet(userId, session);
      const allowanceAmount = Number(amount);

      if (wallet.balance < allowanceAmount) {
        throw new Error('Insufficient wallet balance to create this allowance');
      }

      if (dependent.linkedUser && dependent.careAccessMode === 'linked_wallet') {
        const allocatedAmount = (wallet.dependentSupportAllocations || [])
          .filter((allocation) => allocation.active)
          .reduce((sum, allocation) => sum + Number(allocation.availableAmount || 0), 0);
        const availableBalance = Number(wallet.balance || 0) - allocatedAmount;

        if (availableBalance < allowanceAmount) {
          throw new Error('Insufficient available wallet balance after existing dependent allowances');
        }

        const dependentWallet = await ensureWallet(dependent.linkedUser, session);
        const ownerPreviousBalance = Number(wallet.balance || 0);
        const dependentPreviousBalance = Number(dependentWallet.balance || 0);

        wallet.balance = ownerPreviousBalance - allowanceAmount;
        wallet.totalWithdrawals = Number(wallet.totalWithdrawals || 0) + allowanceAmount;
        wallet.lastTransaction = new Date();
        dependentWallet.balance = dependentPreviousBalance + allowanceAmount;
        dependentWallet.totalDeposits = Number(dependentWallet.totalDeposits || 0) + allowanceAmount;
        dependentWallet.lastTransaction = new Date();

        await wallet.save({ session });
        await dependentWallet.save({ session });

        const reference = `DEP-TRANSFER-${Date.now()}`;
        const ownerTransaction = new Transaction({
          wallet: wallet._id,
          user: userId,
          dependentId: dependent._id,
          type: 'dependent_wallet_transfer',
          amount: allowanceAmount,
          previousBalance: ownerPreviousBalance,
          newBalance: wallet.balance,
          status: 'completed',
          paymentMethod: 'wallet',
          fundingSource: 'walletBalance',
          description: `Transferred funds to ${dependent.fullName}`,
          reference,
          metadata: { dependentId: dependent._id, recipientUserId: dependent.linkedUser, reference: String(reference || '').trim() },
          completedAt: new Date(),
        });
        await ownerTransaction.save({ session });

        const recipientTransaction = new Transaction({
          wallet: dependentWallet._id,
          user: dependent.linkedUser,
          dependentId: dependent._id,
          type: 'dependent_wallet_transfer_received',
          amount: allowanceAmount,
          previousBalance: dependentPreviousBalance,
          newBalance: dependentWallet.balance,
          status: 'completed',
          paymentMethod: 'wallet',
          fundingSource: 'walletBalance',
          description: `Received funds from ${ownerTransaction.user}`,
          reference: `${reference}-RECEIVED`,
          metadata: { dependentId: dependent._id, senderUserId: userId, reference },
          completedAt: new Date(),
        });
        await recipientTransaction.save({ session });

        await session.commitTransaction();
        session.endSession();

        try {
          await notifyUser({
            userId: dependent.linkedUser,
            type: 'wallet_funded',
            title: 'Wallet funded by your sponsor',
            body: `${ownerTransaction.amount.toFixed(2)} was added to your health wallet.`,
            route: '/health-wallet',
            data: { transactionId: String(recipientTransaction._id), amount: String(allowanceAmount) },
          });
        } catch (notifyError) {
          console.warn('[wallet] push failed after dependent transfer:', notifyError?.message || notifyError);
        }

        return res.status(201).json({
          success: true,
          message: 'Funds transferred to dependent wallet',
          transfer: {
            amount: allowanceAmount,
            ownerBalance: wallet.balance,
            dependentBalance: dependentWallet.balance,
            transactionId: recipientTransaction._id,
          },
        });
      }

      const reserved = reserveSponsorAllowanceFunds(wallet, allowanceAmount);
      if (!reserved) {
        throw new Error('Only personal care-wallet funds can be converted into a dependent allowance');
      }

      const allocationIndex = Array.isArray(wallet.dependentSupportAllocations)
        ? wallet.dependentSupportAllocations.findIndex(
            (allocation) => String(allocation.dependentId) === String(dependent._id) && allocation.active
          )
        : -1;

      const ownerUser = await User.findById(userId).select('fullName');
      const sponsorName = String(ownerUser?.fullName || '').trim();

      if (allocationIndex >= 0) {
        const existingAllocation = wallet.dependentSupportAllocations[allocationIndex];
        existingAllocation.availableAmount = Number(existingAllocation.availableAmount || 0) + allowanceAmount;
        existingAllocation.reference = String(reference || existingAllocation.reference || '').trim();
        existingAllocation.sponsorName = sponsorName || existingAllocation.sponsorName;
        existingAllocation.allowedServiceCategories = normalizedCategories;
        existingAllocation.active = true;
        existingAllocation.updatedAt = new Date();
      } else {
        if (!Array.isArray(wallet.dependentSupportAllocations)) {
          wallet.dependentSupportAllocations = [];
        }
        wallet.dependentSupportAllocations.push({
          dependentId: dependent._id,
          sponsorName,
          sponsorPhone: '',
          reference: String(reference || '').trim(),
          availableAmount: allowanceAmount,
          allowedServiceCategories: normalizedCategories,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      wallet.lastTransaction = new Date();
      await wallet.save({ session });

      const transaction = new Transaction({
        wallet: wallet._id,
        user: userId,
        dependentId: dependent._id,
        type: 'dependent_allowance_allocation',
        amount: allowanceAmount,
        previousBalance: wallet.balance,
        newBalance: wallet.balance,
        status: 'completed',
        paymentMethod: 'wallet',
        fundingSource: 'familySupport',
        description: `Created care allowance for ${dependent.fullName}`,
        reference: `ALLOW-${Date.now()}`,
        metadata: {
          dependentId: dependent._id,
          allowedServiceCategories: normalizedCategories,
          reference: String(reference || '').trim(),
          careAccessMode: dependent.careAccessMode,
        },
        completedAt: new Date(),
      });

      await transaction.save({ session });
      await session.commitTransaction();
      session.endSession();

      const allocation = (wallet.dependentSupportAllocations || []).find(
        (entry) => String(entry.dependentId) === String(dependent._id) && entry.active
      );

      return res.status(201).json({
        success: true,
        message: 'Dependent care allowance created',
        allocation,
        reservedFunds: wallet.reservedFunds,
      });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.delete('/dependents/:id', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const dependent = await Dependent.findOneAndUpdate(
      { _id: req.params.id, owner: userId },
      { active: false },
      { new: true }
    );

    if (!dependent) return res.status(404).json({ error: 'Dependent not found' });
    return res.json({ success: true, message: 'Dependent removed', dependentId: dependent._id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Restricted payment endpoint for approved healthcare services only with split funding support
router.post('/pay-approved-service', async (req, res) => {
  try {
    const {
      userId,
      providerId,
      amount,
      serviceCategory,
      serviceDetails,
      dependentId = null,
      split = {},
    } = req.body;

    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!providerId) return res.status(400).json({ error: 'providerId is required' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const normalizedCategory = String(serviceCategory || '').toLowerCase();
    if (!APPROVED_SERVICE_CATEGORIES.has(normalizedCategory)) {
      return res.status(400).json({
        error: 'Funds are restricted to approved healthcare services only',
      });
    }

    if (dependentId) {
      const dependent = await Dependent.findOne({ _id: dependentId, owner: userId, active: true });
      if (!dependent) {
        return res.status(400).json({ error: 'Dependent is invalid for this wallet owner' });
      }
    }

    const provider = await Provider.findById(providerId);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    const totalAmount = Number(amount);

    const activeSubscription = await InsuranceSubscription.findOne({
      user: userId,
      status: 'active',
      endDate: { $gte: new Date() },
    }).populate('plan');

    const normalizedServiceType = SERVICE_TYPE_ALIASES[normalizedCategory] || normalizedCategory;
    const insuranceCoverageEntry = activeSubscription?.plan?.coverageDetails?.find(
      (coverage) => coverage.serviceType === normalizedServiceType || coverage.serviceType === normalizedCategory
    ) || null;

    const coverageUsed = Number(
      activeSubscription?.coverageUsed?.[normalizedServiceType]?.used || 0
    );
    const coverageRemaining = Math.max(
      0,
      Number(insuranceCoverageEntry?.limit || 0) - coverageUsed
    );
    const insuranceCoveredAmount = insuranceCoverageEntry
      ? Math.min(
          totalAmount,
          Math.round((totalAmount * Number(insuranceCoverageEntry.coveragePercentage || 0)) * 100) / 100,
          coverageRemaining
        )
      : 0;

    const defaultSplit = {
      walletBalance: Math.max(0, totalAmount - insuranceCoveredAmount),
      familySupport: 0,
      employerSupport: 0,
      donorVoucher: 0,
      insuranceCoverage: insuranceCoveredAmount,
    };

    const requestedSplit = {
      ...defaultSplit,
      ...split,
    };

    const normalizedSplit = Object.fromEntries(
      Object.entries(requestedSplit).map(([key, value]) => [key, Math.max(0, Number(value) || 0)])
    );

    normalizedSplit.insuranceCoverage = insuranceCoveredAmount;

    const remainingAfterInsurance = Math.max(0, totalAmount - insuranceCoveredAmount);
    const nonWalletSources = normalizedSplit.familySupport + normalizedSplit.employerSupport + normalizedSplit.donorVoucher;
    if (nonWalletSources > remainingAfterInsurance) {
      return res.status(400).json({ error: 'Non-wallet split sources exceed amount remaining after insurance coverage' });
    }

    normalizedSplit.walletBalance = Math.max(0, remainingAfterInsurance - nonWalletSources);

    const splitSum = Object.values(normalizedSplit).reduce((sum, value) => sum + value, 0);
    if (Math.round(splitSum * 100) !== Math.round(totalAmount * 100)) {
      return res.status(400).json({ error: 'Split allocation must equal total amount' });
    }

    const walletDebit = normalizedSplit.walletBalance + normalizedSplit.familySupport + normalizedSplit.employerSupport + normalizedSplit.donorVoucher;
    const totalCovered = normalizedSplit.insuranceCoverage;
    if (Math.round((walletDebit + totalCovered) * 100) !== Math.round(totalAmount * 100)) {
      return res.status(400).json({ error: 'Coverage plus wallet split must equal total amount' });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const wallet = await ensureWallet(userId, session);
      if (wallet.balance < walletDebit) {
        throw new Error('Insufficient wallet balance for requested split');
      }

      if (Number(wallet.reservedFunds.familySupport || 0) < normalizedSplit.familySupport) {
        throw new Error('Insufficient family support funds');
      }

      let appliedDependentSupportAllocation = null;
      if (normalizedSplit.familySupport > 0) {
        if (!dependentId) {
          throw new Error('Family support can only be used for an assigned dependent');
        }

        appliedDependentSupportAllocation = (wallet.dependentSupportAllocations || []).find(
          (allocation) => String(allocation.dependentId) === String(dependentId) && allocation.active
        );

        if (!appliedDependentSupportAllocation) {
          throw new Error('No active family support allocation exists for this dependent');
        }

        const allowedCategories = normalizeSupportCategories(appliedDependentSupportAllocation.allowedServiceCategories);
        if (allowedCategories.length > 0 && !allowedCategories.includes(normalizedCategory)) {
          throw new Error('This sponsor allocation cannot be used for the selected care service');
        }

        if (Number(appliedDependentSupportAllocation.availableAmount || 0) < normalizedSplit.familySupport) {
          throw new Error('Dependent family support allocation is not enough for this payment');
        }
      }

      if (Number(wallet.reservedFunds.employerSupport || 0) < normalizedSplit.employerSupport) {
        throw new Error('Insufficient employer support funds');
      }
      if (Number(wallet.reservedFunds.donorVoucher || 0) < normalizedSplit.donorVoucher) {
        throw new Error('Insufficient donor voucher funds');
      }

      const previousBalance = wallet.balance;
      const newBalance = previousBalance - walletDebit;

      wallet.balance = newBalance;
      wallet.lastTransaction = new Date();
      wallet.reservedFunds.familySupport = Number(wallet.reservedFunds.familySupport || 0) - normalizedSplit.familySupport;
      wallet.reservedFunds.employerSupport = Number(wallet.reservedFunds.employerSupport || 0) - normalizedSplit.employerSupport;
      wallet.reservedFunds.donorVoucher = Number(wallet.reservedFunds.donorVoucher || 0) - normalizedSplit.donorVoucher;
      wallet.reservedFunds.walletBalance = Math.max(0, Number(wallet.reservedFunds.walletBalance || 0) - normalizedSplit.walletBalance);

      if (appliedDependentSupportAllocation) {
        appliedDependentSupportAllocation.availableAmount = Math.max(
          0,
          Number(appliedDependentSupportAllocation.availableAmount || 0) - normalizedSplit.familySupport
        );
        if (appliedDependentSupportAllocation.availableAmount === 0) {
          appliedDependentSupportAllocation.active = false;
        }
        appliedDependentSupportAllocation.updatedAt = new Date();
      }

      // Coverage is a limited benefit, not merely a display estimate. Record
      // the covered amount in the same transaction as the provider payment.
      if (activeSubscription && normalizedSplit.insuranceCoverage > 0) {
        const usage = activeSubscription.coverageUsed || {};
        usage[normalizedServiceType] = {
          used: coverageUsed + normalizedSplit.insuranceCoverage,
          limit: Number(insuranceCoverageEntry.limit || 0),
        };
        activeSubscription.coverageUsed = usage;
        activeSubscription.markModified('coverageUsed');
        activeSubscription.updatedAt = new Date();
        await activeSubscription.save({ session });
      }

      await wallet.save({ session });

      const providerWallet = await ensureWallet(providerId, session);
      providerWallet.balance += totalAmount;
      providerWallet.lastTransaction = new Date();
      await providerWallet.save({ session });

      const transaction = new Transaction({
        wallet: wallet._id,
        user: userId,
        provider: providerId,
        dependentId,
        type: 'approved_healthcare_payment',
        serviceCategory: normalizedCategory,
        amount: totalAmount,
        previousBalance,
        newBalance,
        status: 'completed',
        paymentMethod: 'split',
        fundingSource: 'mixed',
        splitAllocation: normalizedSplit,
        description: serviceDetails || `Payment for ${normalizedCategory}`,
        reference: `HLPAY-${Date.now()}`,
        metadata: {
          serviceDetails,
          insuranceApplied: normalizedSplit.insuranceCoverage > 0,
          insuranceSubscriptionId: activeSubscription?._id || null,
          insuranceCoverageServiceType: insuranceCoverageEntry?.serviceType || null,
          insuranceCoveragePercentage: insuranceCoverageEntry?.coveragePercentage || 0,
          dependentSupportAllocation: appliedDependentSupportAllocation
            ? {
                dependentId: appliedDependentSupportAllocation.dependentId,
                allowedServiceCategories: appliedDependentSupportAllocation.allowedServiceCategories || [],
              }
            : null,
        },
        completedAt: new Date(),
      });

      await transaction.save({ session });

      await session.commitTransaction();
      session.endSession();

      return res.json({
        success: true,
        message: `Payment to ${provider.email || 'provider'} successful`,
        newBalance,
        splitAllocation: normalizedSplit,
        insuranceApplied: normalizedSplit.insuranceCoverage > 0,
        insuranceCoverageRemaining: Math.max(0, coverageRemaining - normalizedSplit.insuranceCoverage),
        transactionId: transaction._id,
      });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.get('/alerts', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const wallet = await ensureWallet(userId);
    const isLowBalance = wallet.balance <= Number(wallet.lowBalanceThreshold || 0);

    return res.json({
      success: true,
      alerts: {
        isLowBalance,
        balance: wallet.balance,
        threshold: wallet.lowBalanceThreshold,
        message: isLowBalance ? 'Care wallet balance is low. Add funds to avoid care disruption.' : '',
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/coverage-estimate', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const wallet = await ensureWallet(userId);
    const balance = Number(wallet.balance || 0);

    const estimate = {
      consultation: Math.floor(balance / COVERAGE_PRICE_BOOK.consultation),
      medicineRefills: Math.floor(balance / COVERAGE_PRICE_BOOK.medicine_refill),
      labTests: Math.floor(balance / COVERAGE_PRICE_BOOK.lab_test),
      emergencyTrips: Math.floor(balance / COVERAGE_PRICE_BOOK.emergency_transport),
    };

    return res.json({
      success: true,
      balance,
      estimate,
      referencePricing: COVERAGE_PRICE_BOOK,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const wallet = await ensureWallet(userId);
    const recentTransactions = await Transaction.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('type amount serviceCategory splitAllocation createdAt status description');

    const reserved = wallet.reservedFunds || {};
    const reservedForHealthcare = Object.values(reserved).reduce((sum, value) => sum + Number(value || 0), 0);

    return res.json({
      success: true,
      summary: {
        balance: wallet.balance,
        reservedForHealthcare,
        reservedFunds: reserved,
        recentTransactions,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});


module.exports = router;
