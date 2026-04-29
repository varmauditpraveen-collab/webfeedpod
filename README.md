# Daily Newsreader Podcast

A web-to-TTS podcast system: paste any website URL, the app auto-discovers its RSS feed, fetches stories twice a day, has Gemini cluster them into topics with spoken-style intros, then converts every story to Kokoro TTS audio. The frontend is a Spotify-style player with resume position, save/skip/jump-back, YouTube video-when-visible / audio-when-hidden, and an Instagram-style mobile UI.

```
newsreader/
├── backend/                Node/Express + MongoDB
│   ├── models/             Mongoose schemas
│   ├── services/           rss, gemini, tts, podcast, db, cleanup
│   ├── routes/             feeds, items, podcast, tts, cleanup
│   ├── public/             Frontend (vanilla JS, Instagram dark theme)
│   ├── storage/audio/      Kokoro WAV files (gitignored, deleted every 24h)
│   ├── server.js
│   ├── package.json
│   └── .env.example
├── tts/                    Kokoro Python sidecar (FastAPI)
│   ├── tts_server.py
│   └── requirements.txt
├── railway.toml            Railway deploy config (Node service)
└── README.md
```

## Quick start (local)

### 1. MongoDB
Start a local Mongo (or use Atlas): `mongod` → `mongodb://localhost:27017/newsreader`.

### 2. Kokoro TTS sidecar
```bash
cd tts
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python tts_server.py            # runs on :8001
```
First run downloads the Kokoro model (~330 MB).

### 3. Backend
```bash
cd backend
cp .env.example .env            # add your GEMINI_API_KEY
npm install
npm start                        # runs on :3000
```

Open <http://localhost:3000>.

## How it works

| Phase | What happens |
|---|---|
| **RSS discovery** | User pastes a website URL. `discoverFeedUrl()` parses `<link rel="alternate">`, then tries `/feed`, `/rss`, `/atom.xml`, `/index.xml`, etc. The discovered feed URL is stored separately so the user only sees website URLs. |
| **Twice-a-day refresh** | `server.js` runs `fetchAllFeeds()` every 12 hours: parses each RSS, dedupes by URL, tags new items with today's `podcastDate`. |
| **Gemini clustering** | `geminiService.categorizeHeadlines()` sends today's headlines to `gemini-2.0-flash` and asks for 3–7 topic clusters with a 2–4 sentence spoken-style intro per cluster. |
| **Kokoro TTS** | `ttsService.synthesize()` POSTs each item's script (and a per-category intro) to the Python sidecar. Audio saved to `backend/storage/audio/<id>.wav`. |
| **Podcast timeline** | `podcastService.buildDailyPodcast()` walks intros + items in cluster order, records the start time of each on a virtual timeline. |
| **Player** | The frontend plays the WAVs sequentially with one `<audio>` element. `currentTime` is mapped onto the virtual timeline so the scrub bar, ±15s skip, and resume position all "just work" — and the podcast naturally grows as new items arrive (just append to the timeline). |
| **YouTube items** | If the item has a `youtubeId`, the artwork box renders a muted, autoplaying YouTube embed while the page is visible (so you watch the video) and falls back to the still image / TTS audio when the page is hidden (PWA-style audio-only). |
| **Save** | Saved items keep their TTS audio file even after the 24h cleanup. The Saved page shows them with a native `<audio controls>`. |
| **Resume** | `/api/podcast/progress` is hit every 5 seconds and on `visibilitychange`. The player restores virtual position and which track was last skipped from (jump-back). |
| **Cleanup** | `POST /api/cleanup/run` deletes unsaved items older than 24h plus their TTS files. Hook it to a cron / Railway scheduled job. |

## API

```
GET    /api/feeds                           list feeds
POST   /api/feeds                  {url}    add feed (auto-discovers RSS)
DELETE /api/feeds/:id                       remove feed
POST   /api/feeds/:id/pin          {isPinned}

GET    /api/items                           shuffled feed items
GET    /api/items/saved                     saved items (with ttsAudioUrl)
POST   /api/items/:id/save                  toggle save
POST   /api/items/:id/read                  mark read

GET    /api/podcast/today                   today's playable timeline
POST   /api/podcast/build                   start (re)build (async)
POST   /api/podcast/build/sync              build and wait
GET    /api/podcast/progress?date=YYYY-MM-DD
POST   /api/podcast/progress       {positionSeconds, currentItemId}
GET    /api/podcast/voice
POST   /api/podcast/voice          {voice}

GET    /api/tts/voices                      Kokoro voice list
GET    /api/tts/health
POST   /api/cleanup/run                     run 24h cleanup
```

## Deploy

- **Backend → Railway** (`railway.toml` provided). Set `MONGO_URI`, `GEMINI_API_KEY`, `KOKORO_URL` env vars.
- **TTS sidecar** is GPU-friendly. Easiest hosts: Modal, Replicate, Runpod, or another Railway service. It only needs to expose `:8001/tts` — point `KOKORO_URL` at it.
- The 12h refresh cycle is built into the backend, but you can also wire `POST /api/cleanup/run` to a scheduled job for cleanup.

## Env vars

| Var | Description |
|---|---|
| `PORT` | backend port (default 3000) |
| `MONGO_URI` | MongoDB connection string |
| `GEMINI_API_KEY` | Google Generative Language API key |
| `GEMINI_MODEL` | default `gemini-2.0-flash` |
| `KOKORO_URL` | URL of the TTS sidecar (default `http://localhost:8001`) |
| `KOKORO_DEVICE` | `cpu` or `cuda` (sidecar) |

## Notes / trade-offs

- **No ffmpeg.** Sequential `<audio>` playback over a virtual timeline is simpler, lets the podcast grow without re-stitching, and works offline-first.
- **Voice changes** apply on the next build (existing TTS files aren't re-rendered automatically — adjustable via the build button on Home).
- **RSS auto-discovery** is pure self-hosted; no external dependency on RSS.app etc. It handles ~95% of common sites.
