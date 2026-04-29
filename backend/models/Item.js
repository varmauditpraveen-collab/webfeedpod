const mongoose = require('mongoose');

const ItemSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    feedId: { type: mongoose.Schema.Types.ObjectId, ref: 'Feed', index: true },
    feedTitle: { type: String, default: '' },
    title: { type: String, required: true },
    link: { type: String, required: true },
    description: { type: String, default: '' },
    content: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    youtubeId: { type: String, default: '' },
    pubDate: { type: Date, default: Date.now },
    podcastDate: { type: String, index: true }, // YYYY-MM-DD
    category: { type: String, default: '' },
    script: { type: String, default: '' }, // text used for TTS
    // Audio paths used to reconstruct the full stitched story in the Saved section.
    // story-intro + each "article chunk" WAV.
    ttsStoryIntroAudioPath: { type: String, default: '' }, // local file path
    ttsStoryIntroDurationSeconds: { type: Number, default: 0 },
    ttsAudioPaths: { type: [String], default: [] }, // local file paths (article chunks)
    ttsAudioDurationsSeconds: { type: [Number], default: [] }, // parallel to ttsAudioPaths

    // Backwards-compat: keep the first chunk audio path at the old field.
    ttsAudioPath: { type: String, default: '' }, // local file path
    ttsDurationSeconds: { type: Number, default: 0 },
    ttsVoice: { type: String, default: '' },
    ttsAttempts: { type: Number, default: 0 },
    ttsLastError: { type: String, default: '' },
    ttsLastAttemptAt: { type: Date, default: null },
    isRead: { type: Boolean, default: false },
    isSaved: { type: Boolean, default: false },
  },
  { timestamps: true }
);

ItemSchema.index({ userId: 1, link: 1 }, { unique: true });

module.exports = mongoose.model('Item', ItemSchema);
