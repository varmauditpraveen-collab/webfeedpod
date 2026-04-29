const express = require('express');
const fs = require('fs');
const Feed = require('../models/Feed');
const Item = require('../models/Item');
const Podcast = require('../models/Podcast');
const { discoverFeedUrl, discoverFavicon, fetchAndParseFeed } = require('../services/rss');

const router = express.Router();

router.get('/', async (req, res) => {
  const feeds = await Feed.find({ userId: req.user.id }).sort({ isPinned: -1, createdAt: -1 }).lean();
  res.json({ feeds });
});

router.post('/', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    let websiteUrl = url.trim();
    if (!/^https?:\/\//i.test(websiteUrl)) websiteUrl = 'https://' + websiteUrl;

    const existing = await Feed.findOne({ userId: req.user.id, websiteUrl });
    if (existing) return res.json({ feed: existing });

    const feedUrl = await discoverFeedUrl(websiteUrl);

    let title = '';
    try {
      const parsed = await fetchAndParseFeed(feedUrl);
      title = parsed.title || '';
    } catch {}

    let iconUrl = '';
    try {
      iconUrl = await discoverFavicon(websiteUrl);
    } catch {}

    const feed = await Feed.create({
      userId: req.user.id,
      websiteUrl,
      feedUrl,
      title,
      iconUrl,
    });
    res.json({ feed });
  } catch (e) {
    console.error('[feeds.add]', e);
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const feedId = req.params.id;
    const userId = req.user.id;

    // 1. Find all items belonging to this feed
    const items = await Item.find({ feedId, userId }).lean();
    const itemIds = items.map((i) => String(i._id));

    // 2. Delete TTS audio files for those items
    for (const item of items) {
      const toDelete = new Set();
      if (item.ttsStoryIntroAudioPath) toDelete.add(item.ttsStoryIntroAudioPath);
      if (item.ttsAudioPath) toDelete.add(item.ttsAudioPath);
      if (Array.isArray(item.ttsAudioPaths)) {
        for (const p of item.ttsAudioPaths) if (p) toDelete.add(p);
      }
      for (const p of toDelete) {
        try { fs.unlinkSync(p); } catch {}
      }
    }

    // 3. Delete items
    await Item.deleteMany({ feedId, userId });

    // 4. Remove timeline entries referencing these items from all podcasts
    if (itemIds.length > 0) {
      const podcasts = await Podcast.find({
        userId,
        'timeline.itemId': { $in: itemIds },
      });

      for (const podcast of podcasts) {
        podcast.timeline = podcast.timeline.filter(
          (entry) => !entry.itemId || !itemIds.includes(String(entry.itemId))
        );
        // Also remove orphaned feed intro entries by checking if any items remain for that feed
        const remainingFeedTitles = new Set(podcast.timeline
          .filter((e) => e.kind === 'item' || e.kind === 'story-intro')
          .map((e) => e.feedTitle));
        podcast.timeline = podcast.timeline.filter(
          (entry) => entry.kind !== 'intro' || remainingFeedTitles.has(entry.title)
        );
        podcast.totalDurationSeconds = podcast.timeline.reduce(
          (sum, e) => sum + (e.durationSeconds || 0), 0
        );
        await podcast.save();
      }
    }

    // 5. Delete the feed itself
    await Feed.findOneAndDelete({ _id: feedId, userId });

    res.json({ ok: true });
  } catch (e) {
    console.error('[feeds.delete]', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/pin', async (req, res) => {
  const feed = await Feed.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id },
    { isPinned: !!req.body.isPinned },
    { new: true }
  );
  if (!feed) return res.status(404).json({ error: 'Feed not found' });
  res.json({ feed });
});

router.patch('/:id/title', async (req, res) => {
  try {
    const { title } = req.body;
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    const feed = await Feed.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { title: title.trim() },
      { new: true }
    );
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    res.json({ feed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
