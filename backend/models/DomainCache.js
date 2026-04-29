const mongoose = require('mongoose');

const domainCacheSchema = new mongoose.Schema({
  domain: { type: String, required: true, unique: true },
  containerSelector: { type: String, default: null },
  lastUpdated: { type: Date, default: Date.now },
});

module.exports = mongoose.model('DomainCache', domainCacheSchema);
