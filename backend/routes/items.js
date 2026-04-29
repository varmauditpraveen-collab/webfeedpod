const express = require('express');
const path = require('path');
const Item = require('../models/Item');

const router = express.Router();

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

router.get('/', async (req, res) => {
  const items = await Item.find({ userId: req.user.id }, {
    title: 1, link: 1, description: 1, imageUrl: 1, youtubeId: 1,
    pubDate: 1, podcastDate: 1, category: 1, feedTitle: 1, feedId: 1,
    isRead: 1, isSaved: 1,
  }).sort({ pubDate: -1 }).limit(500).lean();
  res.json({ items: shuffle(items) });
});

router.get('/failed', async (req, res) => {
  const items = await Item.find(
    { userId: req.user.id, ttsAttempts: { $gt: 0 } },
    { title: 1, feedTitle: 1, ttsAttempts: 1, ttsLastError: 1, ttsVoice: 1, ttsLastAttemptAt: 1, podcastDate: 1 }
  ).sort({ ttsLastAttemptAt: -1 }).limit(100).lean();
  res.json({ items });
});

router.post('/retry-all', async (req, res) => {
  const result = await Item.updateMany(
    { userId: req.user.id, ttsAttempts: { $gt: 0 } },
    { $set: { ttsAttempts: 0, ttsLastError: '' } }
  );
  res.json({ ok: true, modified: result.modifiedCount });
});

router.post('/:id/retry', async (req, res) => {
  const item = await Item.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id },
    { ttsAttempts: 0, ttsLastError: '' },
    { new: true }
  );
  res.json({ item });
});

router.get('/saved', async (req, res) => {
  const items = await Item.find({ userId: req.user.id, isSaved: true }).sort({ updatedAt: -1 }).lean();
  const withUrl = items.map((i) => ({
    ...i,
    // Backwards-compat: first audio chunk
    ttsAudioUrl: i.ttsAudioPath ? `/audio/${path.basename(i.ttsAudioPath)}` : '',
    ttsStoryIntroAudioUrl: i.ttsStoryIntroAudioPath
      ? `/audio/${path.basename(i.ttsStoryIntroAudioPath)}`
      : '',
    ttsAudioUrls: Array.isArray(i.ttsAudioPaths)
      ? i.ttsAudioPaths
          .filter((p) => typeof p === 'string' && p)
          .map((p) => `/audio/${path.basename(p)}`)
      : [],
    ttsStorySegments: (() => {
      const segments = [];
      if (i.ttsStoryIntroAudioPath) {
        segments.push({
          kind: 'story-intro',
          audioUrl: `/audio/${path.basename(i.ttsStoryIntroAudioPath)}`,
          durationSeconds: Number(i.ttsStoryIntroDurationSeconds) || 0,
        });
      }
      const urls = Array.isArray(i.ttsAudioPaths)
        ? i.ttsAudioPaths.filter((p) => typeof p === 'string' && p)
        : [];
      const durations = Array.isArray(i.ttsAudioDurationsSeconds)
        ? i.ttsAudioDurationsSeconds
        : [];
      for (let idx = 0; idx < urls.length; idx++) {
        const p = urls[idx];
        segments.push({
          kind: 'item',
          audioUrl: `/audio/${path.basename(p)}`,
          durationSeconds: Number(durations[idx]) || 0,
        });
      }
      // Filter out any accidental empty entries.
      return segments.filter((s) => s.audioUrl && s.durationSeconds !== null);
    })(),
  }));
  res.json({ items: withUrl });
});

router.post('/:id/save', async (req, res) => {
  const item = await Item.findOne({ _id: req.params.id, userId: req.user.id });
  if (!item) return res.status(404).json({ error: 'not found' });
  item.isSaved = !item.isSaved;
  await item.save();
  res.json({ item });
});

router.post('/:id/read', async (req, res) => {
  const item = await Item.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id },
    { isRead: true },
    { new: true }
  );
  res.json({ item });
});

module.exports = router;
