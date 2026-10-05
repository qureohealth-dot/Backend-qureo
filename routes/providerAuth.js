const express = require("express");
const router = express.Router();
const Provider = require("../models/Provider");
const Pharmacy = require("../models/Pharmacy");
const HealthcareProvider = require("../models/HealthcareProvider");
const LabTest = require("../models/LabTest");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const labProviderAuth = require("../middleware/labProviderAuth");

const JWT_SECRET = process.env.JWT_SECRET || "supersecret123";

// REGISTER new provider
router.post("/register", async (req, res) => {
  try {
    const { name, email, password, phone, address, logo, providerType } = req.body;

    const existing = await Provider.findOne({ email });
    if (existing)
      return res.status(400).json({ error: "Email already registered" });

    const provider = await Provider.create({
      name,
      email,
      password,
      phone,
      address,
      logo,
      providerType: providerType || null,
    });

    await Wallet.findOneAndUpdate(
      { user: provider._id },
      { $setOnInsert: { balance: 0, currency: "USD", status: "active" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const token = jwt.sign({ id: provider._id }, JWT_SECRET, { expiresIn: "7d" });

    res.status(201).json({
      success: true,
      message: "Provider registered successfully",
      token,
      provider: {
        id: provider._id,
        name: provider.name,
        email: provider.email,
        providerType: provider.providerType,
      },
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({
      error: "Failed to register provider",
      details: err.message,
    });
  }
});

// LOGIN provider
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const provider = await Provider.findOne({ email });

    if (!provider) return res.status(404).json({ error: "Provider not found" });

    if (provider.isSuspended) {
      return res.status(403).json({
        error: "This provider account has been suspended. Contact Qureo support.",
        suspendedReason: provider.suspendedReason || null,
      });
    }

    const isMatch = await provider.matchPassword(password);
    if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: provider._id }, JWT_SECRET, { expiresIn: "7d" });

    res.json({
      success: true,
      message: "Login successful",
      token,
      provider: {
        id: provider._id,
        name: provider.name,
        email: provider.email,
        providerType: provider.providerType,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({
      error: "Failed to login provider",
      details: err.message,
    });
  }
});

router.get("/me/wallet", labProviderAuth, async (req, res) => {
  try {
    const wallet = await Wallet.findOneAndUpdate(
      { user: req.labProvider._id },
      { $setOnInsert: { balance: 0, currency: "USD", status: "active" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      success: true,
      wallet: {
        balance: wallet.balance,
        currency: wallet.currency,
        status: wallet.status,
        totalDeposits: wallet.totalDeposits,
        totalWithdrawals: wallet.totalWithdrawals,
        lastTransaction: wallet.lastTransaction,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch lab provider wallet" });
  }
});

router.post("/me/wallet/withdraw", labProviderAuth, async (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ success: false, message: "Enter a valid withdrawal amount" });
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const wallet = await Wallet.findOne({ user: req.labProvider._id }).session(session);
    if (!wallet) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: "Wallet not found" });
    }
    if (Number(wallet.balance || 0) < amount) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Insufficient wallet balance" });
    }

    const previousBalance = Number(wallet.balance || 0);
    const newBalance = previousBalance - amount;
    wallet.balance = newBalance;
    wallet.totalWithdrawals = Number(wallet.totalWithdrawals || 0) + amount;
    wallet.lastTransaction = new Date();
    await wallet.save({ session });

    const transaction = new Transaction({
      wallet: wallet._id,
      user: req.labProvider._id,
      type: "withdrawal",
      amount,
      previousBalance,
      newBalance,
      status: "pending",
      paymentMethod: "bank_transfer",
      description: `Withdrawal of $${amount.toFixed(2)}`,
      reference: `LAB-WITH-${Date.now()}`,
    });
    await transaction.save({ session });
    await session.commitTransaction();

    return res.json({
      success: true,
      message: "Withdrawal initiated",
      newBalance,
      transactionId: transaction._id,
      estimatedCompletion: "24 hours",
    });
  } catch (err) {
    await session.abortTransaction();
    console.error("Lab provider withdrawal error:", err);
    return res.status(500).json({ success: false, message: "Failed to initiate withdrawal" });
  } finally {
    await session.endSession();
  }
});

router.get("/health-wallet", async (req, res) => {
  try {
    const [paymentProviders, pharmacies, healthcareProviders, labNames] = await Promise.all([
      Provider.find().select("name email phone address logo verified").lean(),
      Pharmacy.find().select("name email phone address city logo verified").lean(),
      HealthcareProvider.find({ isActive: { $ne: false } })
        .select("name type address contactPhone contactEmail rating isVerified icon")
        .lean(),
      LabTest.distinct("laboratory", { laboratory: { $type: "string", $ne: "" } }),
    ]);

    const normalizedHealthcareProviders = healthcareProviders.map((provider) => ({
      _id: `healthcare:${provider._id}`,
      providerId: String(provider._id),
      providerSource: "healthcare",
      category: provider.type || "healthcare",
      paymentEnabled: true,
      name: provider.name,
      email: provider.contactEmail,
      phone: provider.contactPhone,
      address: provider.address,
      logo: provider.icon,
      verified: Boolean(provider.isVerified),
      rating: provider.rating,
    }));
    const registeredLabNames = new Set(
      healthcareProviders
        .filter((provider) => provider.type === "lab")
        .map((provider) => String(provider.name || "").trim().toLowerCase())
    );

    const providers = [
      ...paymentProviders.map((provider) => ({
        ...provider,
        _id: `payment:${provider._id}`,
        providerId: String(provider._id),
        providerSource: "payment",
        category: "payment",
        paymentEnabled: true,
      })),
      ...pharmacies.map((pharmacy) => ({
        ...pharmacy,
        _id: `pharmacy:${pharmacy._id}`,
        providerId: String(pharmacy._id),
        providerSource: "pharmacy",
        category: "pharmacy",
        paymentEnabled: true,
        address: [pharmacy.address, pharmacy.city].filter(Boolean).join(", "),
      })),
      ...normalizedHealthcareProviders,
      ...labNames
        .map((name) => String(name || "").trim())
        .filter((name) => name && !registeredLabNames.has(name.toLowerCase()))
        .map((name) => ({
          _id: `lab:${name.toLowerCase()}`,
          providerId: null,
          providerSource: "lab",
          category: "lab",
          paymentEnabled: false,
          name,
          phone: "",
          logo: null,
          verified: false,
        })),
    ];

    return res.json({ providers });
  } catch (err) {
    console.error("Health wallet providers error:", err);
    return res.status(500).json({ error: "Failed to fetch healthcare providers" });
  }
});

// FIND provider by ID
router.get("/:id", async (req, res) => {
  try {
    const provider = await Provider.findById(req.params.id).select("-password");

    if (!provider)
      return res.status(404).json({ error: "Provider not found" });

    res.json({
      success: true,
      provider,
    });
  } catch (err) {
    console.error("Find provider error:", err);
    res.status(500).json({
      error: "Failed to fetch provider",
      details: err.message,
    });
  }
});

router.get("/", async (req, res) => {
  try {
    const providers = await Provider.find().select("-password");
    res.json({ providers });
  } catch (err) {
    console.error("Fetch providers error:", err);
    res.status(500).json({
        error: "Failed to fetch providers",
        details: err.message,
    });
    }
});
module.exports = router;
