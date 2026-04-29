const fs = require('fs');
const path = require('path');
const Item = require('../models/Item');
const Podcast = require('../models/Podcast');
const Progress = require('../models/Progress');
const DomainCache = require('../models/DomainCache');
const tts = require('./tts');
const { abortCurrentBuild } = require('./podcast');

async function runCleanup(userId) {
  if (!userId) throw new Error('runCleanup requires userId');
  // 1. Stop any in-progress build immediately
  const buildWasRunning = abortCurrentBuild(userId);

  // 2. Delete all non-saved items (regardless of age)
  const staleItems = await Item.find({ userId, isSaved: { $ne: true } });

  let deletedItems = 0;
  let deletedFiles = 0;

  for (const it of staleItems) {
    const toDelete = new Set();
    if (it.ttsStoryIntroAudioPath) toDelete.add(it.ttsStoryIntroAudioPath);
    if (it.ttsAudioPath) toDelete.add(it.ttsAudioPath);
    if (Array.isArray(it.ttsAudioPaths)) {
      for (const p of it.ttsAudioPaths) if (p) toDelete.add(p);
    }
    for (const p of toDelete) {
      if (tts.deleteAudioFile(p)) deletedFiles++;
    }
    await it.deleteOne();
    deletedItems++;
  }

  // 3. Orphan audio sweep — remove any .wav files not referenced by remaining items
  try {
    const referenced = new Set();
    const refs = await Item.find(
      {
        userId,
        $or: [
          { ttsAudioPath: { $exists: true, $nin: [null, ''] } },
          { ttsStoryIntroAudioPath: { $exists: true, $nin: [null, ''] } },
          { ttsAudioPaths: { $exists: true, $ne: [] } },
        ],
      },
      {
        ttsAudioPath: 1,
        ttsStoryIntroAudioPath: 1,
        ttsAudioPaths: 1,
      }
    ).lean();
    for (const r of refs) {
      if (r && typeof r.ttsAudioPath === 'string' && r.ttsAudioPath) {
        referenced.add(path.basename(r.ttsAudioPath));
      }
      if (r && typeof r.ttsStoryIntroAudioPath === 'string' && r.ttsStoryIntroAudioPath) {
        referenced.add(path.basename(r.ttsStoryIntroAudioPath));
      }
      if (r && Array.isArray(r.ttsAudioPaths)) {
        for (const p of r.ttsAudioPaths) {
          if (typeof p === 'string' && p) referenced.add(path.basename(p));
        }
      }
    }
    if (fs.existsSync(tts.AUDIO_DIR)) {
      for (const f of fs.readdirSync(tts.AUDIO_DIR)) {
        if (!f.endsWith('.wav')) continue;
        if (f.startsWith('intro-') || f.startsWith('smoke-')) continue;
        if (!referenced.has(f)) {
          try { fs.unlinkSync(path.join(tts.AUDIO_DIR, f)); deletedFiles++; } catch {}
        }
      }
    }
  } catch (e) {
    console.warn('[cleanup] orphan sweep failed:', e.message);
  }

  // 4. Delete all Podcast records (build history / timeline cache)
  const { deletedCount: deletedPodcasts } = await Podcast.deleteMany({ userId });

  // 5. Delete all Progress records (playback positions)
  const { deletedCount: deletedProgress } = await Progress.deleteMany({ userId });

  // 6. Delete all DomainCache records (scraper selector cache)
  // DomainCache is shared (global per domain), so we do not delete it per user cleanup.
  const deletedDomainCache = 0;

  console.log(
    `[cleanup] done — items:${deletedItems} files:${deletedFiles} ` +
    `podcasts:${deletedPodcasts} progress:${deletedProgress} ` +
    `domainCache:${deletedDomainCache} buildStopped:${buildWasRunning}`
  );

  return {
    deletedItems,
    deletedFiles,
    deletedPodcasts,
    deletedProgress,
    deletedDomainCache,
    buildWasRunning,
  };
}

module.exports = { runCleanup };
