const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/newsreader';
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  console.log('[db] connected to', uri);
}

function todayDateStr() {
  // YYYY-MM-DD in UTC for stable keys; client-side display uses local time.
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

module.exports = { connectDB, todayDateStr };
