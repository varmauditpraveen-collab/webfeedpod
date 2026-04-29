function requireAuth(req, res, next) {
  // Passport attaches isAuthenticated + user
  if (typeof req.isAuthenticated === 'function' && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

module.exports = { requireAuth };

