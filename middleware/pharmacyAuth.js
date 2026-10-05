const jwt = require('jsonwebtoken');
const Pharmacy = require('../models/Pharmacy');

const JWT_SECRET = process.env.JWT_SECRET || process.env.AUTH_SECRET ||
  (process.env.NODE_ENV === 'production' ? '' : 'qureo-local-dev-auth-secret');

module.exports = async function pharmacyAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) return res.status(401).json({ message: 'Authentication required' });
    if (!JWT_SECRET) return res.status(500).json({ message: 'Authentication is not configured' });

    const payload = jwt.verify(token, JWT_SECRET);
    const pharmacyId = payload?.sub || payload?.id;
    if (!pharmacyId || payload?.type !== 'pharmacy') {
      return res.status(401).json({ message: 'Invalid pharmacy token' });
    }

    const pharmacy = await Pharmacy.findById(pharmacyId).select('-password -confirmPassword');
    if (!pharmacy) return res.status(401).json({ message: 'Pharmacy account no longer exists' });
    if (pharmacy.isSuspended) return res.status(403).json({ message: 'Pharmacy account is suspended' });
    req.pharmacy = pharmacy;
    return next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired pharmacy token' });
  }
};