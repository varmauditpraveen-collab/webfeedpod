const mongoose = require('mongoose');

const SettingsSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

SettingsSchema.index({ userId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('Settings', SettingsSchema);
