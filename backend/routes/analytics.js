const express = require('express');
const { logAnalyticsEvent, getAnalyticsStats, getRecentAnalyticsEvents } = require('../services/supabase');

const router = express.Router();

// POST /api/analytics/event
// Body: { eventName: string, eventProperties?: object }
router.post('/event', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const eventName = req.body?.eventName;
    if (!eventName) return res.status(400).json({ error: 'eventName is required' });

    await logAnalyticsEvent({
      userId,
      eventName,
      eventProperties: req.body?.eventProperties || {},
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('[analytics/event]', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// GET /api/analytics/stats?days=7
router.get('/stats', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const days = Math.max(1, Number(req.query.days) || 7);
    const stats = await getAnalyticsStats({ userId, days });
    res.json({ stats });
  } catch (e) {
    console.error('[analytics/stats]', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// GET /api/analytics/events?limit=20
router.get('/events', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const events = await getRecentAnalyticsEvents({ userId, limit });
    res.json({ events });
  } catch (e) {
    console.error('[analytics/events]', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

module.exports = router;

