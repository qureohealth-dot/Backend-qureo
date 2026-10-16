const express = require('express');
const jwt = require('jsonwebtoken');
const auth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const User = require('../models/User');
const Doctor = require('../models/Doctor');
const Pharmacy = require('../models/Pharmacy');
const Provider = require('../models/Provider');
const AdminImpersonationLog = require('../models/AdminImpersonationLog');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || process.env.AUTH_SECRET ||
  (process.env.NODE_ENV === 'production' ? '' : 'qureo-local-dev-auth-secret');
const SESSION_DURATION_MS = 15 * 60 * 1000;

router.post('/start', auth, requireAdmin, async (req, res) => {
  const targetType = String(req.body?.targetType || '').trim().toLowerCase();
  const targetId = String(req.body?.targetId || '').trim();
  const modelByType = { user: User, doctor: Doctor, pharmacy: Pharmacy, lab: Provider, payment: Provider };
  const TargetModel = modelByType[targetType];

  if (!TargetModel || !targetId) {
    return res.status(400).json({ message: 'A supported target type and account ID are required.' });
  }
  if (!JWT_SECRET) {
    return res.status(500).json({ message: 'Authentication is not configured on the server.' });
  }

  try {
    const filter = targetType === 'lab' ? { _id: targetId, providerType: 'lab' } : { _id: targetId };
    const target = await TargetModel.findOne(filter).select('-password -passwordHash -confirmPassword').lean();
    if (!target) return res.status(404).json({ message: 'Account not found for this portal.' });
    if (target.isSuspended) return res.status(403).json({ message: 'Suspended accounts cannot be impersonated.' });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
    const session = await AdminImpersonationLog.create({
      adminId: String(req.userId || req.user?._id || 'admin-console'),
      targetType,
      targetId: target._id,
      startedAt: now,
      expiresAt,
    });

    const claims = {
      sub: String(target._id),
      adminImpersonation: true,
      impersonationId: String(session._id),
      impersonatedBy: String(req.userId || req.user?._id || 'admin-console'),
    };
    if (targetType === 'user') {
      claims.email = target.email;
      claims.authProvider = target.authProvider || 'password';
    } else if (targetType === 'doctor') {
      claims.role = 'doctor';
    } else if (targetType === 'pharmacy') {
      claims.type = 'pharmacy';
    } else {
      claims.id = String(target._id);
    }

    const signingSecret = targetType === 'lab' || targetType === 'payment'
      ? process.env.JWT_SECRET || 'supersecret123'
      : JWT_SECRET;
    const token = jwt.sign(claims, signingSecret, { expiresIn: '15m' });
    return res.json({
      token,
      expiresAt: expiresAt.toISOString(),
      target: {
        id: String(target._id),
        type: targetType,
        name: target.fullName || target.name || 'Account',
        email: target.email || '',
      },
    });
  } catch (error) {
    if (error?.name === 'CastError') {
      return res.status(400).json({ message: 'Invalid account ID.' });
    }
    console.error('admin impersonation start error:', error);
    return res.status(500).json({ message: 'Could not start impersonation session.' });
  }
});

module.exports = router;