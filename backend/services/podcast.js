const Feed = require('../models/Feed');
const Item = require('../models/Item');
const Podcast = require('../models/Podcast');
const Settings = require('../models/Settings');
const { fetchAndParseFeed, fetchArticleText, discoverFavicon } = require('./rss');
const gemini = require('./gemini');
const tts = require('./tts');
const { todayDateStr } = require('./db');

// SSE emitter registry — keyed by userId:date
const sseClients = new Map();

// Abort controllers keyed by userId (one active build per user)
const buildAborts = new Map();

function sseKey(userId, date) {
  return `${userId}:${date}`;
}

function registerSSEClient(userId, date, res) {
  const key = sseKey(userId, date);
  if (!sseClients.has(key)) sseClients.set(key, new Set());
  sseClients.get(key).add(res);
}

function unregisterSSEClient(userId, date, res) {
  const key = sseKey(userId, date);
  sseClients.get(key)?.delete(res);
}

function emitSSE(userId, date, event, data) {
  const key = sseKey(userId, date);
  const clients = sseClients.get(key);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify({ event, data })}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
}

/** Abort any in-progress build for this user. Returns true if one was running. */
function abortCurrentBuild(userId) {
  const ctrl = buildAborts.get(String(userId));
  if (!ctrl) return false;
  ctrl.abort();
  buildAborts.delete(String(userId));
  return true;
}

/** Whether a build is currently running for this user */
function isBuildRunning(userId) {
  return buildAborts.has(String(userId));
}

async function fetchAllFeeds(userId) {
  if (!userId) throw new Error('fetchAllFeeds requires a userId');

  const feeds = await Feed.find({ userId });
  const today = todayDateStr();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let totalNew = 0;

  for (const f of feeds) {
    try {
      const { title, items } = await fetchAndParseFeed(f.feedUrl);
      if (title && !f.title) f.title = title;
      if (!f.iconUrl) {
        try { f.iconUrl = await discoverFavicon(f.websiteUrl); } catch {}
      }
      f.lastFetchedAt = new Date();
      await f.save();

      for (const it of items) {
        const safeLink = it.link || f.websiteUrl || f.feedUrl;
        if (!safeLink) continue;
        const pubDate = it.pubDate ? new Date(it.pubDate) : null;
        if (pubDate && pubDate < cutoff) continue;
        const exists = await Item.findOne({ link: safeLink, userId }).lean();
        if (exists) continue;
        await Item.create({
          ...it,
          link: safeLink,
          feedId: f._id,
          feedTitle: f.title || title,
          podcastDate: today,
          userId,
        });
        totalNew++;
      }
    } catch (e) {
      console.warn('[rss] feed error', f.feedUrl, e.message);
    }
  }
  console.log(`[rss] fetched. ${totalNew} new items today (${today}).`);
  return { totalNew, today };
}

async function getVoice(userId) {
  const key = userId ? `voice:${userId}` : 'voice';
  const s = await Settings.findOne({ key }).lean();
  return s?.value || 'af_heart';
}

async function setVoice(userId, voice) {
  const key = userId ? `voice:${userId}` : 'voice';
  await Settings.findOneAndUpdate(
    { key },
    { key, value: voice },
    { upsert: true, new: true }
  );
  return voice;
}

async function buildDailyPodcast(opts = {}) {
  const date = opts.date || todayDateStr();
  const userId = opts.userId;

  if (!userId) throw new Error('buildDailyPodcast requires a userId in opts.');

  const voice = opts.voice || (await getVoice(userId));

  // Register a new abort controller for this user's build
  const abort = new AbortController();
  buildAborts.set(String(userId), abort);
  const signal = abort.signal;

  const podcast = await Podcast.findOneAndUpdate(
    { podcastDate: date, userId },
    { podcastDate: date, userId, voice, status: 'building', statusMessage: 'Gathering items…', timeline: [] },
    { upsert: true, new: true }
  );

  function checkAbort() {
    if (signal.aborted) {
      throw Object.assign(new Error('Build cancelled by cleanup.'), { code: 'ABORTED' });
    }
  }

  try {
    checkAbort();

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const allItems = await Item.find({
      podcastDate: date,
      userId,
      pubDate: { $gte: cutoff },
    }).sort({ pubDate: -1 }).lean();

    if (allItems.length === 0) {
      podcast.timeline = [];
      podcast.totalDurationSeconds = 0;
      podcast.status = 'ready';
      podcast.statusMessage = 'No items for today.';
      podcast.builtAt = new Date();
      await podcast.save();
      emitSSE(userId, date, 'done', { totalDurationSeconds: 0 });
      return podcast;
    }

    // Group items by feedId — preserving feed order
    const feedMap = new Map();
    for (const item of allItems) {
      const key = String(item.feedId);
      if (!feedMap.has(key)) feedMap.set(key, []);
      feedMap.get(key).push(item);
    }

    podcast.statusMessage = 'Synthesizing voice…';
    await podcast.save();

    const timeline = [];
    let cursor = 0;

    for (const [feedId, feedItems] of feedMap) {
      checkAbort();
      const feedTitle = feedItems[0].feedTitle || 'News';

      const categoryIntroText = `From ${feedTitle}.`;
      try {
        const introTts = await tts.synthesize(
          categoryIntroText,
          voice,
          `intro-${date}-${slug(feedId)}-${slug(voice)}`
        );
        checkAbort();
        const entry = {
          kind: 'intro',
          category: feedTitle,
          title: feedTitle,
          audioUrl: introTts.audioUrl,
          durationSeconds: introTts.durationSeconds,
          startSeconds: cursor,
        };
        timeline.push(entry);
        cursor += introTts.durationSeconds;
        podcast.timeline = [...timeline];
        podcast.totalDurationSeconds = cursor;
        await podcast.save();
        emitSSE(userId, date, 'segment', entry);
      } catch (e) {
        if (e.code === 'ABORTED') throw e;
        console.warn(`[tts] feed intro failed (${feedTitle}): ${e.message}`);
      }

      for (const item of feedItems) {
        checkAbort();
        const itemDoc = await Item.findById(item._id);
        if (!itemDoc) continue;
        if (!itemDoc.link) {
          itemDoc.link = `https://google.com/search?q=${encodeURIComponent(itemDoc.title || 'news')}`;
        }

        checkAbort();

        console.log(`[scrape] fetching: ${itemDoc.link}`);
        const { text: articleText, sections, paywall, pubDate: scrapedDate, ogImage } = await fetchArticleText(itemDoc.link);

        if (ogImage && !itemDoc.imageUrl) {
          await Item.findByIdAndUpdate(itemDoc._id, { imageUrl: ogImage });
          itemDoc.imageUrl = ogImage;
        }

        checkAbort();

        if (scrapedDate && scrapedDate < cutoff) {
          console.log(`[scrape] article too old (${scrapedDate.toISOString()}), skipping: ${itemDoc.link}`);
          continue;
        }

        let ttsChunks = [];
        if (paywall) {
          ttsChunks = [`This story from ${itemDoc.feedTitle || 'this source'} is behind a paywall.`];
          console.log(`[scrape] paywall: ${itemDoc.link}`);
        } else if (sections && sections.length > 0) {
          for (const section of sections) {
            if (section.heading) ttsChunks.push(section.heading + '.');
            for (const para of section.paragraphs) {
              ttsChunks.push(para);
            }
          }
        } else if (articleText) {
          ttsChunks = [articleText];
        } else if (itemDoc.description && itemDoc.description.length > 50) {
          ttsChunks = [itemDoc.description];
          console.log(`[scrape] fallback to description: ${itemDoc.link}`);
        } else {
          console.log(`[scrape] no content, skipping: ${itemDoc.link}`);
        }

        if (ttsChunks.length === 0) continue;

        let storyIntroText;
        try {
          storyIntroText = await gemini.introForItem({
            title: itemDoc.title,
            description: itemDoc.description,
            feedTitle: itemDoc.feedTitle,
          });
        } catch {
          storyIntroText = `Next up, ${itemDoc.title}.`;
        }

        checkAbort();

        const storyId = String(itemDoc._id);
        const nonEmptyChunks = ttsChunks.filter(c => c.trim());

        try {
          const storyIntroTts = await tts.synthesize(
            storyIntroText,
            voice,
            `story-intro-${itemDoc._id}-${slug(voice)}`
          );
          checkAbort();
          const entry = {
            kind: 'story-intro',
            storyId,
            isLastChunk: false,
            itemId: itemDoc._id,
            category: feedTitle,
            title: itemDoc.title,
            audioUrl: storyIntroTts.audioUrl,
            durationSeconds: storyIntroTts.durationSeconds,
            startSeconds: cursor,
            imageUrl: itemDoc.imageUrl,
            feedTitle: itemDoc.feedTitle,
            link: itemDoc.link,
            youtubeId: itemDoc.youtubeId,
          };
          timeline.push(entry);
          cursor += storyIntroTts.durationSeconds;
          podcast.timeline = [...timeline];
          podcast.totalDurationSeconds = cursor;
          await podcast.save();
          emitSSE(userId, date, 'segment', entry);
        } catch (e) {
          if (e.code === 'ABORTED') throw e;
          console.warn(`[tts] story intro failed "${itemDoc.title}": ${e.message}`);
        }

        checkAbort();

        if (nonEmptyChunks.length > 0) {
          try {
            let totalArticleDuration = 0;
            let firstAudioPath = null;
            let emittedCount = 0;

            for (let ci = 0; ci < ttsChunks.length; ci++) {
              checkAbort();
              const chunk = ttsChunks[ci].trim();
              if (!chunk) continue;
              const articleTts = await tts.synthesize(
                chunk,
                voice,
                `article-${itemDoc._id}-chunk${ci}-${slug(voice)}`
              );
              checkAbort();
              if (emittedCount === 0) firstAudioPath = articleTts.audioPath;
              totalArticleDuration += articleTts.durationSeconds;
              emittedCount++;

              const chunkEntry = {
                kind: 'item',
                storyId,
                isLastChunk: emittedCount === nonEmptyChunks.length,
                itemId: itemDoc._id,
                category: feedTitle,
                title: itemDoc.title,
                audioUrl: articleTts.audioUrl,
                durationSeconds: articleTts.durationSeconds,
                startSeconds: cursor,
                imageUrl: itemDoc.imageUrl,
                feedTitle: itemDoc.feedTitle,
                link: itemDoc.link,
                youtubeId: itemDoc.youtubeId,
              };
              timeline.push(chunkEntry);
              cursor += articleTts.durationSeconds;
              podcast.timeline = [...timeline];
              podcast.totalDurationSeconds = cursor;
              await podcast.save();
              emitSSE(userId, date, 'segment', chunkEntry);
            }

            itemDoc.ttsAudioPath = firstAudioPath;
            itemDoc.ttsDurationSeconds = totalArticleDuration;
            itemDoc.ttsVoice = voice;
            itemDoc.ttsAttempts = 0;
            itemDoc.ttsLastError = '';
            itemDoc.category = feedTitle;
            await itemDoc.save();
          } catch (e) {
            if (e.code === 'ABORTED') throw e;
            const msg = e.message || String(e);
            itemDoc.ttsLastError = msg;
            itemDoc.ttsLastAttemptAt = new Date();
            const isInfraError = /cannot reach KOKORO_URL|Invalid URL|kokoro timeout|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(msg);
            if (!isInfraError) itemDoc.ttsAttempts = (itemDoc.ttsAttempts || 0) + 1;
            itemDoc.ttsVoice = voice;
            await itemDoc.save();
            console.warn(`[tts] article failed "${itemDoc.title}": ${msg}`);
          }
        }
      }
    }

    podcast.timeline = timeline;
    podcast.totalDurationSeconds = cursor;
    podcast.voice = voice;
    podcast.status = 'ready';
    podcast.statusMessage = '';
    podcast.builtAt = new Date();
    await podcast.save();
    emitSSE(userId, date, 'done', { totalDurationSeconds: cursor });
    return podcast;
  } catch (e) {
    if (e.code === 'ABORTED') {
      console.log('[buildDailyPodcast] aborted by cleanup.');
      try {
        podcast.status = 'error';
        podcast.statusMessage = 'Cancelled by cleanup.';
        await podcast.save();
        emitSSE(userId, date, 'error', { message: 'Cancelled by cleanup.' });
      } catch {}
      return;
    }
    console.error('[buildDailyPodcast]', e);
    podcast.status = 'error';
    podcast.statusMessage = e.message;
    await podcast.save();
    emitSSE(userId, date, 'error', { message: e.message });
    throw e;
  } finally {
    if (buildAborts.get(String(userId)) === abort) {
      buildAborts.delete(String(userId));
    }
  }
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
}

module.exports = {
  fetchAllFeeds, buildDailyPodcast, getVoice, setVoice,
  registerSSEClient, unregisterSSEClient,
  abortCurrentBuild, isBuildRunning,
};
