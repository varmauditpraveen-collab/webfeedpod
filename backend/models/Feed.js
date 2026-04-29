const mongoose = require('mongoose');

const FeedSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    websiteUrl: { type: String, required: true },
    feedUrl: { type: String, required: true },
    title: { type: String, default: '' },
    iconUrl: { type: String, default: '' },
    isPinned: { type: Boolean, default: false },
    lastFetchedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

FeedSchema.index({ userId: 1, websiteUrl: 1 }, { unique: true });

module.exports = mongoose.model('Feed', FeedSchema);
