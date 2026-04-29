require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { connectDB } = require('./services/db');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { upsertUserFromGoogle, getUserById } = require('./services/supabase');
const { requireAuth } = require('./middleware/auth');

const app = express();

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || true,
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

// Sessions (stored in Postgres via connect-pg-simple)
const pgPool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
});

// Required for Railway's reverse proxy to pass correct protocol for secure cookies
app.set('trust proxy', 1);

app.use(
  session({
    store: new PgSession({
      pool: pgPool,
      createTableIfMissing: true, // auto-creates session table if not present
    }),
    secret: process.env.SESSION_SECRET || 'dev-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // secure requires NODE_ENV=production to be set in Railway env vars
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Passport Google strategy -> Supabase-backed user upsert
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:
        process.env.GOOGLE_CALLBACK_URL ||
        'http://localhost:3000/auth/google/callback',
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const user = await upsertUserFromGoogle(profile);
        if (!user) return done(new Error('upsertUserFromGoogle returned null — check Supabase RLS or service role key'));
        return done(null, user);
      } catch (e) {
        return done(e);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const u = await getUserById(id);
    if (!u) return done(null, false); // user deleted — treat as logged out
    return done(null, u);
  } catch (e) {
    return done(e);
  }
});

// Serve TTS audio
app.use(
  '/audio',
  express.static(path.join(__dirname, 'storage', 'audio'), {
    maxAge: '1h',
    fallthrough: true,
  })
);

// OAuth routes
app.use('/auth', require('./routes/auth'));

// API routes (auth-guarded)
app.use('/api', requireAuth);
app.use('/api/feeds', require('./routes/feeds'));
app.use('/api/items', require('./routes/items'));
app.use('/api/podcast', require('./routes/podcast'));
app.use('/api/tts', require('./routes/tts'));
app.use('/api/cleanup', require('./routes/cleanup'));
app.use('/api/analytics', require('./routes/analytics'));

// Frontend runtime config
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  const config = {
    GA_MEASUREMENT_ID: process.env.GA_MEASUREMENT_ID || '',
  };
  res.send(`window.__APP_CONFIG__ = ${JSON.stringify(config)};`);
});

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/audio/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

(async () => {
  await connectDB();
  app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
})().catch((e) => {
  console.error('Fatal startup error', e);
  process.exit(1);
});
