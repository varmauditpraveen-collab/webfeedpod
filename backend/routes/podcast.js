const express = require('express');
const Podcast = require('../models/Podcast');
const Progress = require('../models/Progress');
const {
  buildDailyPodcast, fetchAllFeeds, getVoice, setVoice,
  registerSSEClient, unregisterSSEClient,
  isBuildRunning,
} = require('../services/podcast');
const { todayDateStr } = require('../services/db');
const router = express.Router();

router.get('/today', async (req, res) => {
  const date = req.query.date || todayDateStr();
  const p = await Podcast.findOne({ userId: req.user.id, podcastDate: date }).lean();
  res.json({ podcast: p });
});

router.post('/build', async (req, res) => {
  if (isBuildRunning(req.user.id)) return res.json({ ok: true, alreadyBuilding: true });
  res.json({ ok: true, started: true });
  // Fetch fresh feed items first, then build the podcast
  fetchAllFeeds(req.user.id)
    .catch((e) => console.error('[build fetch]', e))
    .then(() => buildDailyPodcast({ userId: req.user.id, voice: req.body?.voice }))
    .catch((e) => console.error('[build async]', e));
});

// SSE endpoint — client connects here to receive segments in realtime
router.get('/stream', (req, res) => {
  const date = req.query.date || todayDateStr();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('data: {"event":"connected"}\n\n');

  registerSSEClient(req.user.id, date, res);

  req.on('close', () => {
    unregisterSSEClient(req.user.id, date, res);
  });
});

router.get('/progress', async (req, res) => {
  const date = req.query.date || todayDateStr();
  const p = await Progress.findOne({ userId: req.user.id, podcastDate: date }).lean();
  res.json({ progress: p || { positionSeconds: 0, currentItemId: null } });
});

router.post('/progress', async (req, res) => {
  const date = req.body.date || todayDateStr();
  const update = {
    userId: req.user.id,
    podcastDate: date,
    positionSeconds: Number(req.body.positionSeconds) || 0,
    updatedAt: new Date(),
  };
  if (req.body.currentItemId) update.currentItemId = req.body.currentItemId;
  if (req.body.lastSkippedFromItemId) update.lastSkippedFromItemId = req.body.lastSkippedFromItemId;
  const progress = await Progress.findOneAndUpdate(
    { userId: req.user.id, podcastDate: date },
    update,
    { upsert: true, new: true }
  );
  res.json({ progress });
});

router.get('/voice', async (req, res) => {
  res.json({ voice: await getVoice(req.user.id) });
});

router.post('/voice', async (req, res) => {
  if (!req.body.voice) return res.status(400).json({ error: 'voice is required' });
  res.json({ voice: await setVoice(req.user.id, req.body.voice) });
});

module.exports = router;
