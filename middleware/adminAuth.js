/**
 * Admin authorisation for operator-only routes.
 *
 * There is no `role` on the User model, so authorisation is an explicit id
 * allowlist rather than a permission check: set `ADMIN_IDS` (falling back to the
 * older `SUPPORT_ADMIN_IDS`) to a comma-separated list of user ids.
 *
 * Callers must pass the `auth` middleware first — this guard only rejects
 * identities that are not on the list, it does not verify the token itself.
 */
function getAdminIds() {
  return (process.env.ADMIN_IDS || process.env.SUPPORT_ADMIN_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function requireAdmin(req, res, next) {
  const userId = req.userId || req.user?._id;

  if (userId && getAdminIds().includes(String(userId))) {
    return next();
  }

  return res.status(403).json({ message: 'Administrator access required' });
}

module.exports = { requireAdmin, getAdminIds };