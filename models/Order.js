// models/Order.js
const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  items: [
    {
      medicine: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
      quantity: { type: Number, required: true },
      name : {type : String, required : true},
      price: { type: Number, required: true }
    }
  ],
  totalPrice: { type: Number, required: true },
  pharmacy: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy' },
  status: {
    type: String,
    enum: ['Pending', 'Processing', 'Completed', 'Cancelled'],
    default: 'Pending'
  },
  deliveryInfo: {
  fullName: String,
  address: String,
  phone: String,
},

  paymentMethod: { type: String, enum: ['Cash', 'Card', 'Mobile', 'Qureo-Wallet'], default: 'Cash' },
  paymentStatus: { type: String, enum: ['pending', 'paid', 'refunded'], default: 'pending' },
  paymentTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
