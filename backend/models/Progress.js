const mongoose = require('mongoose');

const ProgressSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    podcastDate: { type: String, required: true },
    positionSeconds: { type: Number, default: 0 },
    currentItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Item' },
    lastSkippedFromItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Item' },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

ProgressSchema.index({ userId: 1, podcastDate: 1 }, { unique: true });

module.exports = mongoose.model('Progress', ProgressSchema);
