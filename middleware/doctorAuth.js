const jwt = require('jsonwebtoken');
const Doctor = require('../models/Doctor');

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.AUTH_SECRET ||
  (process.env.NODE_ENV === 'production' ? '' : 'qureo-local-dev-auth-secret');

module.exports = async function doctorAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token || !JWT_SECRET) {
      return res.status(token ? 500 : 401).json({ message: token ? 'Authentication is not configured' : 'Authentication required' });
    }

    const payload = jwt.verify(token, JWT_SECRET);
    if (payload?.role !== 'doctor' || !payload?.sub) {
      return res.status(401).json({ message: 'Invalid doctor token' });
    }

    const doctor = await Doctor.findById(payload.sub).select('-passwordHash');
    if (!doctor) return res.status(401).json({ message: 'Doctor no longer exists' });
    req.doctor = doctor;
    req.doctorId = String(doctor._id);
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired doctor token' });
  }
};