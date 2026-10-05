// routes/order.js
const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Cart = require('../models/Cart');
const Pharmacy = require('../models/Pharmacy');
const Transaction = require('../models/Transaction');
const auth = require('../middleware/auth');
const mongoose = require('mongoose');

const getIO = () => {
  try {
    return require('../index').io;
  } catch {
    return null;
  }
};

// ✅ Create order from cart
router.post("/", auth, async (req, res) => {
  try {
    const { paymentMethod, pharmacy: requestedPharmacyId, paymentTransactionId } = req.body;

    // Populate medicine + its pharmacy reference
    const cart = await Cart.findOne({ user: req.userId })
      .populate('items.medicine');

    if (!cart || cart.items.length === 0)
      return res.status(400).json({ message: "Cart is empty" });

    const cartPharmacyNames = [...new Set(cart.items.map((item) => String(item.medicine?.pharmacy || '').trim()).filter(Boolean))];
    let pharmacy = null;
    if (requestedPharmacyId && mongoose.isValidObjectId(requestedPharmacyId)) {
      pharmacy = await Pharmacy.findById(requestedPharmacyId);
    } else if (cartPharmacyNames.length === 1) {
      const candidate = cartPharmacyNames[0];
      pharmacy = mongoose.isValidObjectId(candidate)
        ? await Pharmacy.findById(candidate)
        : await Pharmacy.findOne({ name: { $regex: `^${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
    }
    if (!pharmacy) return res.status(400).json({ message: 'A valid pharmacy is required for this order' });

    const belongsToPharmacy = cartPharmacyNames.length === 1 && cart.items.every((item) => {
      const owner = String(item.medicine?.pharmacy || '').trim();
      return owner.toLowerCase() === pharmacy.name.trim().toLowerCase() || owner === String(pharmacy._id);
    });
    if (!belongsToPharmacy) {
      return res.status(400).json({ message: 'All medicines in the cart must belong to the selected pharmacy' });
    }

    let paymentTransaction = null;
    if (paymentTransactionId) {
      paymentTransaction = await Transaction.findOne({
        _id: paymentTransactionId,
        user: req.userId,
        status: 'completed',
        'metadata.pharmacyId': String(pharmacy._id),
      });
      if (!paymentTransaction) {
        return res.status(400).json({ message: 'The payment could not be verified for this pharmacy' });
      }
      if (paymentTransaction.metadata?.orderId || await Order.exists({ paymentTransaction: paymentTransaction._id })) {
        return res.status(409).json({ message: 'This payment has already been attached to an order' });
      }
    }
    console.log("items", cart.items)
    const order = new Order({
      user: req.userId,
      items: cart.items.map((i) => ({
        medicine: i.medicine._id,
        quantity: i.quantity,
        name : i.medicine.name,
        price: i.price,
      })),
      totalPrice: paymentTransaction?.amount ?? cart.totalPrice,
      pharmacy: pharmacy._id,
      paymentMethod,
      paymentStatus: paymentTransaction ? 'paid' : 'pending',
      paymentTransaction: paymentTransaction?._id || null,
    });

   
    await order.save();
    await Cart.findOneAndDelete({ user: req.userId });

    res.json({ message: "Order created successfully", order });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ message: "Failed to create order", error: err.message });
  }
});


// ✅ Get all orders for a user
router.get('/', auth, async (req, res) => {
  try {
    const orders = await Order.find({ user: req.userId })
      .populate('items.medicine')
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch orders', error: err.message });
  }
});

// recieve orders for pharmacies 

router.get("/order", async(req, res)=>{


    const orders = await Order.find()

    res.json(orders)


})

// ✅ Get single order
router.get('/:id', auth, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.userId })
      .populate('items.medicine');
    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch order', error: err.message });
  }
});

// ✅ Admin: Update order status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // Emit real-time delivery update to the patient
    try {
      const io = getIO();
      if (io && order.user) {
        io.to(String(order.user)).emit('orderDeliveryUpdate', {
          orderId: String(order._id),
          status: order.status,
          userId: String(order.user),
        });
      }
    } catch (emitErr) {
      console.error('Failed to emit orderDeliveryUpdate:', emitErr.message);
    }

    res.json(order);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update order status', error: err.message });
  }
});

// ✅ Admin: Delete order
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Order.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Order not found' });
    res.json({ message: 'Order deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete order', error: err.message });
  }
});

module.exports = router;
