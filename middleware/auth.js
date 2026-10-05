const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.AUTH_SECRET ||
  (process.env.NODE_ENV === 'production' ? '' : 'qureo-local-dev-auth-secret');

module.exports = async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    if (token) {
      if (!JWT_SECRET) {
        return res.status(500).json({ message: 'Authentication is not configured' });
      }

      const payload = jwt.verify(token, JWT_SECRET);
      const userId = payload?.sub || payload?.id;

      if (!userId) {
        return res.status(401).json({ message: 'Invalid auth token' });
      }

      if (payload?.role === 'admin-console' && userId === 'admin-console') {
        req.userId = 'admin-console';
        req.isAdminConsole = true;
        return next();
      }

      const user = await User.findById(userId).select('_id fullName email authProvider');
      if (!user) {
        return res.status(401).json({ message: 'User no longer exists' });
      }

      req.user = user;
      req.userId = String(user._id);
      return next();
    }

    if (process.env.ALLOW_INSECURE_USERID_AUTH === 'true') {
      const userId = req.body?.userId || req.query?.userId;
      if (userId) {
        req.userId = userId;
        return next();
      }
    }

    return res.status(401).json({ message: 'Authentication required' });
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired auth token' });
  }
};
