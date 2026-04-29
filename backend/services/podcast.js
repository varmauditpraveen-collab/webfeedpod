const fs = require('fs');
const Feed = require('../models/Feed');
const Item = require('../models/Item');
const Podcast = require('../models/Podcast');
const Settings = require('../models/Settings');
const { fetchAndParseFeed, fetchArticleText, discoverFavicon } = require('./rss');
const gemini = require('./gemini');
const tts = require('./tts');
const { todayDateStr } = require('./db');

// SSE emitter registry — keyed by date
const sseClients = new Map();

// Abort controller for the currently-running build (null when idle)
let currentBuildAbort = null;

function registerSSEClient(date, res) {
  if (!sseClients.has(date)) sseClients.set(date, new Set());
  sseClients.get(date).add(res);
}

function unregisterSSEClient(date, res) {
  sseClients.get(date)?.delete(res);
}

function emitSSE(date, event, data) {
  const clients = sseClients.get(date);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify({ event, data })}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
}

/** Abort any in-progress build. Returns true if a build was running. */
function abortCurrentBuild() {
  if (!currentBuildAbort) return false;
  currentBuildAbort.abort();
  currentBuildAbort = null;
  return true;
}

/** Whether a build is currently running */
function isBuildRunning() {
  return currentBuildAbort !== null;
}

// FIX: Added opts so we can pass userId when fetching feeds
async function fetchAllFeeds(opts = {}) {
  const userId = opts.userId;
  // Scope feeds to the user if a userId is provided
  const query = userId ? { userId } : {}; 
  const feeds = await Feed.find(query);
  
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
        
        // Ensure we check for existing links for THIS user
        const existsQuery = userId ? { link: safeLink, userId } : { link: safeLink };
        const exists = await Item.findOne(existsQuery).lean();
        if (exists) continue;
        
        await Item.create({
          ...it,
          userId: userId, // FIX: Save the item to this specific user to satisfy Mongoose
          link: safeLink,
          feedId: f._id,
          feedTitle: f.title || title,
          podcastDate: today,
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

async function getVoice() {
  const s = await Settings.findOne({ key: 'voice' }).lean();
  return s?.value || 'af_heart';
}

async function setVoice(voice) {
  await Settings.findOneAndUpdate(
    { key: 'voice' },
    { key: 'voice', value: voice },
    { upsert: true, new: true }
  );
  return voice;
}

// FIX: Added strict userId handling
async function buildDailyPodcast(opts = {}) {
  const date = opts.date || todayDateStr();
  const voice = opts.voice || (await getVoice());
  const userId = opts.userId;

  // Safety net to catch missing user data
  if (!userId) {
    throw new Error('userId is required to build a podcast');
  }

  // Register a new abort controller for this build
  const abort = new AbortController();
  currentBuildAbort = abort;
  const signal = abort.signal;

  // FIX: Added userId to the query and update payload
  const podcast = await Podcast.findOneAndUpdate(
    { podcastDate: date, userId: userId },
    { podcastDate: date, userId: userId, voice, status: 'building', statusMessage: 'Gathering items…', timeline: [] },
    { upsert: true, new: true }
  );

  /** Throw if cleanup/abort was requested mid-build */
  function checkAbort() {
    if (signal.aborted) {
      throw Object.assign(new Error('Build cancelled by cleanup.'), { code: 'ABORTED' });
    }
  }

  try {
    checkAbort();

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // FIX: Scope item finding to this specific user
    const allItems = await Item.find({
      userId: userId,
      podcastDate: date,
      pubDate: { $gte: cutoff },
    }).sort({ pubDate: -1 }).lean();

    if (allItems.length === 0) {
      podcast.timeline = [];
      podcast.totalDurationSeconds = 0;
      podcast.status = 'ready';
      podcast.statusMessage = 'No items for today.';
      podcast.builtAt = new Date();
      await podcast.save();
      emitSSE(date, 'done', { totalDurationSeconds: 0 });
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
        emitSSE(date, 'segment', entry);
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
          emitSSE(date, 'segment', entry);
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
              emitSSE(date, 'segment', chunkEntry);
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
    emitSSE(date, 'done', { totalDurationSeconds: cursor });
    return podcast;
  } catch (e) {
    if (e.code === 'ABORTED') {
      console.log('[buildDailyPodcast] aborted by cleanup.');
      try {
        podcast.status = 'error';
        podcast.statusMessage = 'Cancelled by cleanup.';
        await podcast.save();
        emitSSE(date, 'error', { message: 'Cancelled by cleanup.' });
      } catch {}
      return;
    }
    console.error('[buildDailyPodcast]', e);
    podcast.status = 'error';
    podcast.statusMessage = e.message;
    await podcast.save();
    emitSSE(date, 'error', { message: e.message });
    throw e;
  } finally {
    // Clear the controller only if it's still ours
    if (currentBuildAbort === abort) {
      currentBuildAbort = null;
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
