const express = require('express');
const passport = require('passport');
const { getUserById } = require('../services/supabase');

const router = express.Router();

// Initiates Google OAuth
router.get(
  '/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
  })
);

// OAuth callback
router.get(
  '/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/',
    session: true,
  }),
  (req, res) => {
    // Redirect back to the SPA root.
    res.redirect('/');
  }
);

router.get('/me', async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
  // req.user should already be hydrated via passport.deserializeUser.
  // If not, try once more.
  const u = req.user?.google_sub ? req.user : await getUserById(req.user.id);
  return res.json({ user: u });
});

router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session?.destroy(() => {});
    res.json({ ok: true });
  });
});

router.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session?.destroy(() => {});
    res.redirect('/');
  });
});

module.exports = router;

