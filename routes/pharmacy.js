const express = require("express");
const router = express.Router();
const Pharmacy = require("../models/Pharmacy");
const auth = require("../middleware/auth");
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken");
const Medicine = require("../models/Medicine");
const Order = require("../models/Order");
const PharmacyWallet = require("../models/PharmacyWallet");
const PharmacyWalletTransaction = require("../models/PharmacyWalletTransaction");
const pharmacyAuth = require("../middleware/pharmacyAuth");

const JWT_SECRET = process.env.JWT_SECRET || process.env.AUTH_SECRET ||
  (process.env.NODE_ENV === "production" ? "" : "qureo-local-dev-auth-secret");

const getOrCreatePharmacyWallet = (pharmacyId, options = {}) => PharmacyWallet.findOneAndUpdate(
  { pharmacy: pharmacyId },
  { $setOnInsert: { balance: 0, currency: "USD", status: "active" } },
  { upsert: true, new: true, setDefaultsOnInsert: true, ...options }
);
// CREATE pharmacy with logo URL
router.post("/", async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      address,
      city,
      description,
      logo,
      password,
      confirmPassword,
    } = req.body;

    // check if pharmacy already exists
    const existing = await Pharmacy.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: "Pharmacy already exists" });
    }

    // check password match
    if (password !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match" });
    }

    // create pharmacy
    const pharmacy = new Pharmacy({
      name,
      email,
      phone,
      address,
      city,
      description,
      logo,
      password,
      confirmPassword,
    });

    await pharmacy.save();
    await getOrCreatePharmacyWallet(pharmacy._id);

    res.status(201).json({
      message: "Pharmacy registered successfully",
      pharmacy: {
        _id: pharmacy._id,
        id: pharmacy._id,
        name: pharmacy.name,
        email: pharmacy.email,
        phone: pharmacy.phone,
        city: pharmacy.city,
      },
    });
  } catch (err) {
    console.error("❌ Registration error:", err);
    res.status(500).json({ message: "Failed to register pharmacy", error: err.message });
  }
});

router.get("/delete/:id", async (req, res) => {
  try {
    const deleted = await Pharmacy.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Pharmacy not found" });
    res.json({ message: "Pharmacy deleted" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete pharmacy", error: err.message });
  }
});


router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // find pharmacy
    const pharmacy = await Pharmacy.findOne({ email }).select("+password");
    if (!pharmacy) {
      return res.status(404).json({ message: "Pharmacy not found" });
    }

    if (pharmacy.isSuspended) {
      return res.status(403).json({
        message: "This pharmacy account has been suspended. Contact Qureo support.",
        suspendedReason: pharmacy.suspendedReason || null,
      });
    }

    // check password
    const isMatch = await bcrypt.compare(password, pharmacy.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid password" });
    }

    if (!JWT_SECRET) {
      return res.status(500).json({ message: "Authentication is not configured" });
    }

    const token = jwt.sign(
      { sub: String(pharmacy._id), type: "pharmacy" },
      JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );
    await getOrCreatePharmacyWallet(pharmacy._id);

    res.json({
      message: "Login successful",
      token,
      pharmacy: {
        _id: pharmacy._id,
        id: pharmacy._id,
        name: pharmacy.name,
        email: pharmacy.email,
        phone: pharmacy.phone,
        address: pharmacy.address,
        city: pharmacy.city,
        description: pharmacy.description,
        logo: pharmacy.logo,
      },
    });
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ message: "Failed to login", error: err.message });
  }
});

router.get("/me/dashboard", pharmacyAuth, async (req, res) => {
  try {
    const pharmacy = req.pharmacy;
    const wallet = await getOrCreatePharmacyWallet(pharmacy._id);
    const pharmacyKeys = [pharmacy.name, String(pharmacy._id)];
    const [medicines, orders, transactions] = await Promise.all([
      Medicine.find({ pharmacy: { $in: pharmacyKeys } }).sort({ updatedAt: -1 }).limit(8).lean(),
      Order.find({ pharmacy: pharmacy._id })
        .populate("items.medicine", "name images")
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      PharmacyWalletTransaction.find({ pharmacy: pharmacy._id })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
    ]);
    const [medicineCount, inStockCount, orderCount, pendingOrderCount, lowStockCount] = await Promise.all([
      Medicine.countDocuments({ pharmacy: { $in: pharmacyKeys } }),
      Medicine.countDocuments({ pharmacy: { $in: pharmacyKeys }, available: true }),
      Order.countDocuments({ pharmacy: pharmacy._id }),
      Order.countDocuments({ pharmacy: pharmacy._id, status: "Pending" }),
      Medicine.countDocuments({ pharmacy: { $in: pharmacyKeys }, available: true, stock: { $exists: true } }),
    ]);

    res.json({
      pharmacy: { id: pharmacy._id, name: pharmacy.name, city: pharmacy.city, logo: pharmacy.logo },
      wallet: {
        balance: wallet.balance,
        currency: wallet.currency,
        status: wallet.status,
        totalReceived: wallet.totalReceived,
        totalPaidOut: wallet.totalPaidOut,
        lastTransaction: wallet.lastTransaction,
      },
      stats: { medicineCount, inStockCount, orderCount, pendingOrderCount, lowStockCount },
      medicines,
      orders,
      recentTransactions: transactions,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load pharmacy dashboard", error: err.message });
  }
});

router.get("/me/wallet", pharmacyAuth, async (req, res) => {
  try {
    const wallet = await getOrCreatePharmacyWallet(req.pharmacy._id);
    const transactions = await PharmacyWalletTransaction.find({ pharmacy: req.pharmacy._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ wallet, transactions });
  } catch (err) {
    res.status(500).json({ message: "Failed to load pharmacy wallet", error: err.message });
  }
});

router.get("/me/medicines", pharmacyAuth, async (req, res) => {
  try {
    const pharmacyKeys = [req.pharmacy.name, String(req.pharmacy._id)];
    const medicines = await Medicine.find({ pharmacy: { $in: pharmacyKeys } })
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();
    res.json({ medicines });
  } catch (err) {
    res.status(500).json({ message: "Failed to load pharmacy inventory", error: err.message });
  }
});

router.get("/me/orders", pharmacyAuth, async (req, res) => {
  try {
    const orders = await Order.find({ pharmacy: req.pharmacy._id })
      .populate("items.medicine", "name images")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ message: "Failed to load pharmacy orders", error: err.message });
  }
});

router.patch("/me/orders/:id/status", pharmacyAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['Processing', 'Completed'].includes(status)) {
      return res.status(400).json({ message: "Unsupported order status" });
    }

    const order = await Order.findOne({ _id: req.params.id, pharmacy: req.pharmacy._id });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.paymentStatus !== 'paid') {
      return res.status(409).json({ message: "Order must be paid before fulfillment" });
    }
    const validTransition = (order.status === 'Pending' && status === 'Processing') ||
      (order.status === 'Processing' && status === 'Completed');
    if (!validTransition) {
      return res.status(409).json({ message: "Order cannot move to the requested status" });
    }

    order.status = status;
    await order.save();
    res.json({ order });
  } catch (err) {
    res.status(500).json({ message: "Failed to update order", error: err.message });
  }
});


// UPDATE pharmacy (including logo)
router.patch("/:id", async (req, res) => {
  try {
    const updated = await Pharmacy.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updated) return res.status(404).json({ message: "Pharmacy not found" });
    res.json({ message: "Pharmacy updated", pharmacy: updated });
  } catch (err) {
    res.status(500).json({ message: "Failed to update pharmacy", error: err.message });
  }
});

// GET all pharmacies
router.get("/", async (req, res) => {
  try {
    const pharmacies = await Pharmacy.find().select("-password -confirmPassword");
    res.json(pharmacies);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch pharmacies", error: err.message });
  }
});

// GET single pharmacy
router.get("/:id", async (req, res) => {
  try {
    const pharmacy = await Pharmacy.findById(req.params.id).select("-password -confirmPassword");
    if (!pharmacy) return res.status(404).json({ message: "Pharmacy not found" });
    res.json(pharmacy);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch pharmacy", error: err.message });
  }
});

// DELETE pharmacy
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await Pharmacy.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Pharmacy not found" });
    res.json({ message: "Pharmacy deleted" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete pharmacy", error: err.message });
  }
});


// DELETE pharmacy
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await Pharmacy.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Pharmacy not found" });
    res.json({ message: "Pharmacy deleted" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete pharmacy", error: err.message });
  }
});



module.exports = router;
