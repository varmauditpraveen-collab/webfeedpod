const mongoose = require('mongoose');

const TimelineEntrySchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['intro', 'item', 'story-intro'] },
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Item' },
    category: { type: String, default: '' },
    title: { type: String, default: '' },
    audioUrl: { type: String, default: '' },
    durationSeconds: { type: Number, default: 0 },
    startSeconds: { type: Number, default: 0 },
    youtubeId: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    feedTitle: { type: String, default: '' },
    link: { type: String, default: '' },
  },
  { _id: false }
);

const PodcastSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    podcastDate: { type: String, required: true },
    voice: { type: String, default: 'af_heart' },
    timeline: [TimelineEntrySchema],
    totalDurationSeconds: { type: Number, default: 0 },
    builtAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ['pending', 'building', 'ready', 'error'],
      default: 'pending',
    },
    statusMessage: { type: String, default: '' },
  },
  { timestamps: true }
);

PodcastSchema.index({ userId: 1, podcastDate: 1 }, { unique: true });

module.exports = mongoose.model('Podcast', PodcastSchema);
