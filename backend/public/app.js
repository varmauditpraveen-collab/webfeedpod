const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showLogin() {
  // Stop any stitched-story playback when switching back to login.
  try { stopSavedStoryPlayback(); } catch {}
  const a = $('#audio');
  if (a) {
    try { a.pause(); } catch {}
    try { a.src = ''; } catch {}
  }

  $$('.page').forEach((p) => p.classList.remove('active'));
  const login = $('#page-login');
  if (login) login.classList.add('active');

  $('#tabs')?.classList.add('hidden');
  $('#user-bar')?.classList.add('hidden');
  state.currentUser = null;
  state.isAuthenticated = false;
  emitGaEvent('login_viewed', {});
}

function setAuthed(user) {
  $$('.page').forEach((p) => p.classList.remove('active'));
  const home = $('#page-home');
  if (home) home.classList.add('active');

  $('#tabs')?.classList.remove('hidden');
  $('#user-bar')?.classList.remove('hidden');

  const avatar = $('#user-avatar');
  if (avatar) avatar.src = user?.avatar_url || '';
  const name = $('#user-name');
  if (name) name.textContent = user?.name || user?.email || 'User';
  state.currentUser = user || null;
  state.isAuthenticated = !!user?.id;

  // Keep tab state consistent after auth bootstrap.
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'home'));
  trackEvent('login_success', {}, { backend: false });
}

async function apiRequest(method, p, body) {
  const headers = body ? { 'Content-Type': 'application/json' } : undefined;
  const r = await fetch(p, {
    method,
    headers,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });

  if (r.status === 401) {
    showLogin();
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }

  // Some endpoints might return empty bodies; tolerate that.
  return r.json().catch(() => ({}));
}

const api = {
  async get(p) { return apiRequest('GET', p); },
  async post(p, body) { return apiRequest('POST', p, body); },
  async patch(p, body) { return apiRequest('PATCH', p, body); },
  async del(p) { return apiRequest('DELETE', p); },
};

const state = {
  podcast: null,
  index: 0,           // raw timeline index (chunk level)
  storyIndex: 0,      // story-level index (for Next / Prev)
  stories: [],        // [{storyId, firstChunk, lastChunk, title, …}]
  positionInTrack: 0,
  isPlaying: false,
  lastSkippedFromStoryIndex: null,
  voice: 'af_heart',
  voices: [],
  feeds: [],
  saved: [],
  savedPlayer: null, // { audio, segments, index } for "stitched story" playback
  building: false,
  sseSource: null,
  currentUser: null,
  isAuthenticated: false,
};

// Optional GA4 bootstrap (set GA_MEASUREMENT_ID via /config.js from server.js)
function initGoogleAnalytics() {
  try {
    const id = window.__APP_CONFIG__?.GA_MEASUREMENT_ID;
    if (!id || typeof id !== 'string') return;
    if (!id.startsWith('G-')) return;
    if (window.__gaBootstrapped) return;
    window.__gaBootstrapped = true;

    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
    document.head.appendChild(s);

    window.gtag('js', new Date());
    window.gtag('config', id, { anonymize_ip: true });
  } catch {}
}
initGoogleAnalytics();

function emitGaEvent(eventName, eventProperties) {
  try {
    if (window.gtag) window.gtag('event', eventName, eventProperties || {});
  } catch {}
}

function trackEvent(eventName, eventProperties = {}, opts = { backend: true }) {
  emitGaEvent(eventName, eventProperties);
  if (opts.backend && state.isAuthenticated) {
    api.post('/api/analytics/event', { eventName, eventProperties }).catch(() => {});
  }
}

/* ── Story index helpers ─────────────────────────────────────────────────── */
function rebuildStories() {
  const t = state.podcast?.timeline || [];
  const stories = [];
  let openStory = null;
  for (let i = 0; i < t.length; i++) {
    const seg = t[i];
    const sid = seg.storyId;
    if (!sid) continue; // feed-level intros have no storyId — skip
    if (!openStory || openStory.storyId !== sid) {
      openStory = { storyId: sid, firstChunk: i, lastChunk: i,
                    title: seg.title, imageUrl: seg.imageUrl,
                    feedTitle: seg.feedTitle, link: seg.link,
                    category: seg.category, youtubeId: seg.youtubeId,
                    itemId: seg.itemId, isSaved: seg.isSaved };
      stories.push(openStory);
    } else {
      openStory.lastChunk = i;
    }
  }
  state.stories = stories;
}

function storyIndexForChunk(chunkIdx) {
  for (let s = 0; s < state.stories.length; s++) {
    const st = state.stories[s];
    if (chunkIdx >= st.firstChunk && chunkIdx <= st.lastChunk) return s;
  }
  for (let s = 0; s < state.stories.length; s++) {
    if (state.stories[s].firstChunk > chunkIdx) return s;
  }
  return state.stories.length - 1;
}

const audio = $('#audio');
const audioPre = new Audio();
audioPre.preload = 'auto';

/* ── Blob-cache ──────────────────────────────────────────────────────────── */
const blobCache = new Map();

async function ensureCached(url) {
  if (blobCache.has(url)) return blobCache.get(url).objectURL;
  const resp = await fetch(url);
  const blob = await resp.blob();
  const objectURL = URL.createObjectURL(blob);
  blobCache.set(url, { objectURL, blob });
  return objectURL;
}

function evictCacheExcept(keepUrls) {
  for (const [url, { objectURL }] of blobCache) {
    if (!keepUrls.has(url)) {
      URL.revokeObjectURL(objectURL);
      blobCache.delete(url);
    }
  }
}

async function prefetchNext() {
  const t = state.podcast?.timeline || [];
  const nextIdx = state.index + 1;
  if (nextIdx >= t.length) return;
  const url = t[nextIdx].audioUrl;
  const objUrl = await ensureCached(url);
  if (audioPre.src !== objUrl) {
    audioPre.src = objUrl;
    audioPre.load();
  }
}

/* ---------- Tabs ---------- */
$$('.tabs button').forEach((b) =>
  b.addEventListener('click', () => switchTab(b.dataset.tab))
);

// Auth UI
$('#btn-login-google')?.addEventListener('click', () => {
  trackEvent('login_clicked', {}, { backend: false });
  window.location.href = '/auth/google';
});
$('#btn-logout')?.addEventListener('click', () => {
  trackEvent('logout_clicked', {});
  window.location.href = '/auth/logout';
});
$('#btn-article')?.addEventListener('click', () => {
  const t = state.podcast?.timeline || [];
  const e = t[state.index];
  trackEvent('article_open_clicked', { itemId: e?.itemId ? String(e.itemId) : null });
});

function switchTab(tab) {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${tab}`));
  if (tab === 'feeds') loadFeeds();
  if (tab === 'saved') loadSaved();
  if (tab === 'settings') loadSettings();
  trackEvent('tab_switched', { tab }, { backend: false });
}

/* ---------- Virtual timeline ---------- */
function virtualPosition() {
  const t = state.podcast?.timeline || [];
  if (!t.length) return 0;
  return (t[state.index]?.startSeconds || 0) + state.positionInTrack;
}
function totalDuration() { return state.podcast?.totalDurationSeconds || 0; }
function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
function findIndexAt(virtualSec) {
  const t = state.podcast?.timeline || [];
  for (let i = 0; i < t.length; i++) {
    const e = t[i];
    if (virtualSec < e.startSeconds + e.durationSeconds) return { i, offset: Math.max(0, virtualSec - e.startSeconds) };
  }
  return { i: t.length - 1, offset: t[t.length - 1]?.durationSeconds || 0 };
}

function loadTrack(i, offsetSec = 0, autoplay = true, seamless = false) {
  const t = state.podcast?.timeline || [];
  if (!t.length) return;
  const newIndex = Math.max(0, Math.min(i, t.length - 1));
  state.index = newIndex;
  state.positionInTrack = offsetSec;
  const entry = t[newIndex];
  renderNowPlaying();

  if (seamless && offsetSec === 0) {
    const objUrl = audioPre.src;
    if (objUrl) {
      audio.src = objUrl;
      audio.currentTime = 0;
      if (autoplay) audio.play().catch(() => {});
      prefetchNext();
      return;
    }
  }

  ensureCached(entry.audioUrl).then(objUrl => {
    audio.src = objUrl;
    if (offsetSec) audio.currentTime = offsetSec;
    if (autoplay) audio.play().catch(() => {});
    prefetchNext();
    const keepUrls = new Set();
    for (let ci = Math.max(0, newIndex - 1); ci <= Math.min(t.length - 1, newIndex + 3); ci++) {
      if (t[ci]) keepUrls.add(t[ci].audioUrl);
    }
    evictCacheExcept(keepUrls);
  }).catch(e => console.warn('[loadTrack]', e));
}

function renderNowPlaying() {
  const t = state.podcast?.timeline || [];
  if (!t.length) return;
  const e = t[state.index];

  rebuildStories();
  const si = storyIndexForChunk(state.index);
  const story = si >= 0 ? state.stories[si] : null;
  const meta = story || e;

  $('#np-category').textContent = meta.category || e.category || '';
  $('#np-title').textContent = meta.title || e.title || '';
  $('#np-feed').textContent = meta.feedTitle || e.feedTitle || '';

  const ytWrap = $('#artwork-yt');
  const img = $('#artwork-img');
  if (meta.youtubeId && document.visibilityState === 'visible') {
    img.classList.add('hidden');
    ytWrap.classList.remove('hidden');
    ytWrap.innerHTML = `<iframe src="https://www.youtube.com/embed/${meta.youtubeId}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&loop=1&playlist=${meta.youtubeId}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  } else {
    ytWrap.classList.add('hidden');
    ytWrap.innerHTML = '';
    img.classList.remove('hidden');
    img.src = meta.imageUrl || e.imageUrl || '';
    img.onerror = () => { img.removeAttribute('src'); };
  }

  // Check state locally before wiping the button text
  const isSaved = meta.isSaved || e.isSaved;
  $('#btn-save').textContent = isSaved ? '★ Saved' : '☆ Save';

  const articleBtn = $('#btn-article');
  if (e.link) {
    articleBtn.href = e.link;
    articleBtn.classList.remove('hidden');
  } else {
    articleBtn.removeAttribute('href');
    articleBtn.classList.add('hidden');
  }
  if (e.kind === 'item' && e.itemId) {
    fetch('/api/items/' + e.itemId + '/read', { method: 'POST', credentials: 'include' }).catch(() => {});
  }
  updateScrub();
}

function updateScrub() {
  const total = totalDuration();
  const cur = virtualPosition();
  $('#time-current').textContent = fmt(cur);
  $('#time-total').textContent = fmt(total);
  const scrub = $('#scrub');
  scrub.max = total > 0 ? total : 1;
  scrub.value = cur;
  const pct = total > 0 ? (cur / total) * 100 : 0;
  scrub.style.setProperty('--p', pct + '%');
}

audio.addEventListener('timeupdate', () => {
  state.positionInTrack = audio.currentTime;
  updateScrub();
});
audio.addEventListener('ended', () => {
  const t = state.podcast?.timeline || [];
  if (state.index < t.length - 1) {
    loadTrack(state.index + 1, 0, true, true);
  } else if (state.building) {
    setStatus('Waiting for next segment…');
  } else {
    state.isPlaying = false;
    $('#btn-play').textContent = '▶';
    saveProgress();
  }
});
audio.addEventListener('play', () => {
  state.isPlaying = true;
  $('#btn-play').textContent = '❚❚';
});
audio.addEventListener('pause', () => {
  state.isPlaying = false;
  $('#btn-play').textContent = '▶';
  saveProgress();
});
audio.addEventListener('loadedmetadata', () => {
  const t = state.podcast?.timeline || [];
  const cur = t[state.index];
  if (cur && Math.abs(cur.durationSeconds - audio.duration) > 0.5 && isFinite(audio.duration)) {
    cur.durationSeconds = audio.duration;
    let cursor = 0;
    for (const e of t) { e.startSeconds = cursor; cursor += e.durationSeconds; }
    state.podcast.totalDurationSeconds = cursor;
    updateScrub();
  }
});

$('#btn-play').addEventListener('click', () => {
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
  trackEvent('player_play_pause_clicked', { paused: audio.paused });
});

$('#btn-prev').addEventListener('click', () => {
  const t = state.podcast?.timeline || [];
  if (!t.length) return;

  let currentStoryStart = state.index;
  const currentId = t[state.index].itemId;

  if (currentId) {
    while (currentStoryStart > 0 && t[currentStoryStart - 1].itemId === currentId) {
      currentStoryStart--;
    }
  }

  if (audio.currentTime > 3 || state.index > currentStoryStart) {
    state.lastSkippedFromIndex = state.index;
    loadTrack(currentStoryStart, 0);
    return;
  }

  state.lastSkippedFromIndex = state.index;
  let targetIndex = 0; 
  for (let i = currentStoryStart - 1; i >= 0; i--) {
    if (t[i].kind === 'story-intro' || t[i].kind === 'intro') {
      targetIndex = i;
      break;
    }
  }
  loadTrack(targetIndex, 0);
  trackEvent('player_prev_clicked', {});
});

$('#btn-next').addEventListener('click', () => {
  const t = state.podcast?.timeline || [];
  if (!t.length) return;

  state.lastSkippedFromIndex = state.index;
  const currentId = t[state.index].itemId;

  let targetIndex = -1;
  for (let i = state.index + 1; i < t.length; i++) {
    if (t[i].itemId !== currentId || t[i].kind === 'intro') {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex !== -1) {
    loadTrack(targetIndex, 0);
  } else if (!state.building) {
    audio.currentTime = audio.duration;
  }
  trackEvent('player_next_clicked', {});
});

$('#btn-back15').addEventListener('click', () => {
  seekVirtual(virtualPosition() - 15);
  trackEvent('player_back_15_clicked', {});
});
$('#btn-fwd15').addEventListener('click', () => {
  seekVirtual(virtualPosition() + 15);
  trackEvent('player_forward_15_clicked', {});
});

// --- SIMPLE SAVE LOGIC (WITH UI STATE FIX) ---
$('#btn-save').addEventListener('click', async () => {
  const t = state.podcast?.timeline || [];
  const e = t[state.index];
  if (!e || e.kind !== 'item' || !e.itemId) return;

  // Make the API call to toggle the save state
  const res = await api.post('/api/items/' + e.itemId + '/save');
  const isSaved = res.item?.isSaved;
  trackEvent('save_toggled', { itemId: String(e.itemId), isSaved: !!isSaved });
  
  // Update the UI
  $('#btn-save').textContent = isSaved ? '★ Saved' : '☆ Save';
  
  // Store the new state locally so future re-renders remember it
  e.isSaved = isSaved;
  const si = storyIndexForChunk(state.index);
  if (si >= 0) {
    state.stories[si].isSaved = isSaved;
  }
});

$('#scrub').addEventListener('input', (ev) => seekVirtual(parseFloat(ev.target.value)));
$('#scrub').addEventListener('change', () => trackEvent('player_scrubbed', {}));

function seekVirtual(virtualSec) {
  const total = totalDuration();
  virtualSec = Math.max(0, Math.min(virtualSec, total));
  const { i, offset } = findIndexAt(virtualSec);
  if (i !== state.index) loadTrack(i, offset, !audio.paused);
  else { audio.currentTime = offset; state.positionInTrack = offset; updateScrub(); }
}

/* ---------- SSE ---------- */
function connectSSE(date) {
  if (state.sseSource) { state.sseSource.close(); state.sseSource = null; }
  const src = new EventSource(`/api/podcast/stream?date=${encodeURIComponent(date)}`);
  state.sseSource = src;

  src.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.event === 'segment') {
      const segment = msg.data;
      if (!state.podcast) {
        state.podcast = { timeline: [], totalDurationSeconds: 0, podcastDate: date, status: 'building' };
      }
      segment.startSeconds = state.podcast.totalDurationSeconds;
      state.podcast.timeline.push(segment);
      state.podcast.totalDurationSeconds += segment.durationSeconds;
      rebuildStories();

      if (state.podcast.timeline.length === 1) {
        $('#player').classList.remove('hidden');
        $('#empty-home').style.display = 'none';
        loadTrack(0, 0, true);
      } else if (!state.isPlaying && audio.ended) {
        loadTrack(state.podcast.timeline.length - 1, 0, true);
      } else {
        prefetchNext();
      }
      updateScrub();
      const storyCount = state.stories.length;
      setStatus(`Building… ${storyCount} stor${storyCount === 1 ? 'y' : 'ies'} ready`);
    }

    if (msg.event === 'done') {
      state.building = false;
      if (state.podcast) {
        state.podcast.status = 'ready';
        state.podcast.totalDurationSeconds = msg.data.totalDurationSeconds;
      }
      setStatus('');
      src.close();
      state.sseSource = null;
    }

    if (msg.event === 'error') {
      state.building = false;
      setStatus('Build error: ' + msg.data.message);
      src.close();
      state.sseSource = null;
    }
  };

  src.onerror = () => {
    if (!state.building) { src.close(); state.sseSource = null; }
  };
}

/* ---------- Progress ---------- */
let progressTimer = null;
function startProgressLoop() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(saveProgress, 5000);
}
async function saveProgress() {
  if (!state.podcast?.timeline?.length) return;
  const cur = state.podcast.timeline[state.index];
  rebuildStories();
  const lastSkippedStory = state.lastSkippedFromStoryIndex !== null
    ? state.stories[state.lastSkippedFromStoryIndex] : null;
  await api.post('/api/podcast/progress', {
    date: state.podcast.podcastDate,
    positionSeconds: virtualPosition(),
    currentItemId: cur?.itemId || null,
    lastSkippedFromItemId: lastSkippedStory?.itemId || null,
  }).catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  saveProgress();
  if (state.podcast?.timeline?.length) renderNowPlaying();
});

/* ---------- Build & Today ---------- */
$('#build-btn').addEventListener('click', async () => {
  trackEvent('build_clicked', {});
  buildToday().catch(() => {});
});
async function buildToday() {
  const date = new Date().toISOString().slice(0, 10);
  trackEvent('build_started', { date });
  state.building = true;
  state.podcast = null;
  setStatus('Starting build…');
  connectSSE(date);
  await api.post('/api/podcast/build');
}

async function loadToday() {
  const { podcast } = await api.get('/api/podcast/today');
  if (!podcast || !podcast.timeline?.length) {
    $('#player').classList.add('hidden');
    $('#empty-home').style.display = '';
    return;
  }
  if (podcast.status === 'building') {
    state.podcast = podcast;
    state.building = true;
    const date = podcast.podcastDate;
    connectSSE(date);
    if (podcast.timeline.length > 0) {
      $('#player').classList.remove('hidden');
      $('#empty-home').style.display = 'none';
      loadTrack(0, 0, false);
    }
    setStatus(`Building… ${podcast.timeline.length} segments ready`);
    return;
  }
  state.podcast = podcast;
  $('#player').classList.remove('hidden');
  $('#empty-home').style.display = 'none';
  const { progress } = await api.get('/api/podcast/progress?date=' + encodeURIComponent(podcast.podcastDate));
  const startAt = progress?.positionSeconds || 0;
  const { i, offset } = findIndexAt(startAt);
  loadTrack(i, offset, false);
  rebuildStories();
  if (progress?.lastSkippedFromItemId) {
    state.lastSkippedFromStoryIndex = state.stories.findIndex(
      (s) => String(s.itemId || '') === String(progress.lastSkippedFromItemId)
    );
  }
  startProgressLoop();
  setStatus('');
}

function setStatus(s) { $('#status').textContent = s || ''; }

/* ---------- Feeds ---------- */
$('#feed-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const url = $('#feed-url').value.trim();
  if (!url) return;
  $('#feed-url').value = '';
  const res = await api.post('/api/feeds', { url });
  if (res.error) alert('Could not add feed: ' + res.error);
  trackEvent('feed_added', { url });
  loadFeeds();
});

async function loadFeeds() {
  const { feeds } = await api.get('/api/feeds');
  state.feeds = feeds || [];
  const ul = $('#feed-list');
  ul.innerHTML = '';
  for (const f of state.feeds) {
    const li = document.createElement('li');
    li.className = 'feed-card' + (f.isPinned ? ' pinned' : '');
    li.innerHTML = `
      <img src="${f.iconUrl || ''}" onerror="this.style.visibility='hidden'" alt="" />
      <div class="meta">
        <div class="title">
          <span class="feed-title-text" data-id="${f._id}" title="Click to rename">${escapeHtml(f.title || f.websiteUrl)}</span>
          <input class="feed-title-input hidden" data-id="${f._id}" type="text" value="${escapeHtml(f.title || f.websiteUrl)}" maxlength="80" />
        </div>
        <div class="url">${escapeHtml(f.websiteUrl)}</div>
      </div>
      <div class="actions">
        <button data-pin="${f._id}">${f.isPinned ? '★' : '☆'}</button>
        <button data-del="${f._id}">✕</button>
      </div>`;
    ul.appendChild(li);
  }

  ul.querySelectorAll('.feed-title-text').forEach((span) => {
    span.addEventListener('click', () => {
      const input = ul.querySelector(`.feed-title-input[data-id="${span.dataset.id}"]`);
      span.classList.add('hidden');
      input.classList.remove('hidden');
      input.focus();
      input.select();
    });
  });
  ul.querySelectorAll('.feed-title-input').forEach((input) => {
    const commit = async () => {
      const newTitle = input.value.trim();
      const span = ul.querySelector(`.feed-title-text[data-id="${input.dataset.id}"]`);
      if (newTitle && newTitle !== span.textContent) {
        await api.patch(`/api/feeds/${input.dataset.id}/title`, { title: newTitle });
        span.textContent = newTitle;
        const f = state.feeds.find((x) => x._id === input.dataset.id);
        if (f) f.title = newTitle;
        trackEvent('feed_title_updated', { feedId: input.dataset.id });
      }
      input.classList.add('hidden');
      span.classList.remove('hidden');
    };
    const cancel = () => {
      const span = ul.querySelector(`.feed-title-text[data-id="${input.dataset.id}"]`);
      input.value = span.textContent;
      input.classList.add('hidden');
      span.classList.remove('hidden');
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    });
  });

  ul.querySelectorAll('[data-pin]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.getAttribute('data-pin');
      const f = state.feeds.find((x) => x._id === id);
      await api.post(`/api/feeds/${id}/pin`, { isPinned: !f.isPinned });
      trackEvent('feed_pin_toggled', { feedId: id, isPinned: !f.isPinned });
      loadFeeds();
    })
  );
  ul.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Remove this feed?')) return;
      const feedId = b.getAttribute('data-del');
      await api.del(`/api/feeds/${feedId}`);
      trackEvent('feed_deleted', { feedId });
      loadFeeds();
    })
  );
}

/* ---------- Saved ---------- */
async function loadSaved() {
  const { items } = await api.get('/api/items/saved');
  state.saved = items || [];
  const ul = $('#saved-list');
  ul.innerHTML = '';
  if (!state.saved.length) {
    ul.innerHTML = `<div class="empty">No saved items yet.</div>`;
    return;
  }
  for (const it of state.saved) {
    const li = document.createElement('li');
    li.className = 'saved-card';

    const fullText = (it.content || it.description || '').trim();

    li.innerHTML = `
      <div class="head">
        <img src="${it.imageUrl || ''}" onerror="this.style.visibility='hidden'" alt="" />
        <div class="body">
          <div class="feed">${escapeHtml(it.feedTitle || '')}</div>
          <h3>${escapeHtml(it.title)}</h3>
          <a href="${it.link}" target="_blank" rel="noopener noreferrer">Open ↗</a>
        </div>
      </div>
      ${fullText ? `<div class="saved-content">${fullText}</div>` : ''}
      <div class="row" style="margin-top:8px">
        <button data-play="${it._id}" class="ghost">▶ Play</button>
        <button data-unsave="${it._id}" class="ghost">Unsave</button>
      </div>
    `;
    ul.appendChild(li);
  }
  ul.querySelectorAll('[data-play]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.getAttribute('data-play');
      const it = state.saved.find((x) => String(x._id) === String(id));
      trackEvent('saved_story_play_clicked', { itemId: id });
      playSavedStory(it);
    })
  );
  ul.querySelectorAll('[data-unsave]').forEach((b) =>
    b.addEventListener('click', async () => {
      stopSavedStoryPlayback();
      const itemId = b.getAttribute('data-unsave');
      await api.post('/api/items/' + itemId + '/save');
      trackEvent('saved_story_unsaved', { itemId });
      loadSaved();
    })
  );
}

function stopSavedStoryPlayback() {
  const p = state.savedPlayer;
  if (p?.audio) {
    try { p.audio.pause(); } catch {}
    try { p.audio.src = ''; } catch {}
  }
  state.savedPlayer = null;
}

function playSavedStory(it) {
  const segments = it?.ttsStorySegments;
  if (!segments || !Array.isArray(segments) || segments.length === 0) return;

  stopSavedStoryPlayback();

  let idx = 0;
  const audio = new Audio(segments[0].audioUrl);
  audio.preload = 'auto';
  state.savedPlayer = { audio, segments, index: 0 };

  function playCurrent() {
    const cur = segments[idx];
    if (!cur?.audioUrl) return;
    try { audio.src = cur.audioUrl; } catch {}
    state.savedPlayer.index = idx;
    audio.play().catch(() => {});
  }

  audio.onended = () => {
    idx += 1;
    if (idx >= segments.length) return stopSavedStoryPlayback();
    playCurrent();
  };
  audio.onerror = () => {
    // If a segment fails, skip it so the rest of the stitched story still plays.
    idx += 1;
    if (idx >= segments.length) return stopSavedStoryPlayback();
    playCurrent();
  };

  playCurrent();
}

/* ---------- Settings ---------- */
async function loadSettings() {
  const [{ voice }, voicesRes] = await Promise.all([
    api.get('/api/podcast/voice'),
    api.get('/api/tts/voices').catch(() => ({ voices: [] })),
  ]);
  state.voice = voice;
  state.voices = voicesRes.voices || [];
  const sel = $('#voice-select');
  sel.innerHTML = '';
  const list = state.voices.length ? state.voices : [voice || 'af_heart'];
  for (const v of list) {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    if (v === state.voice) opt.selected = true;
    sel.appendChild(opt);
  }
}
$('#voice-select').addEventListener('change', async (ev) => {
  await api.post('/api/podcast/voice', { voice: ev.target.value });
  trackEvent('voice_changed', { voice: ev.target.value });
});
$('#rebuild-btn').addEventListener('click', () => {
  trackEvent('rebuild_clicked', {});
  switchTab('home');
  buildToday();
});
$('#cleanup-btn').addEventListener('click', async () => {
  if (!confirm('This will delete all cached items, audio files, podcast builds, and playback progress (saved items and feeds are kept). Continue?')) return;
  
  const r = await api.post('/api/cleanup/run');
  trackEvent('cleanup_run', {
    deletedItems: r.deletedItems || 0,
    deletedFiles: r.deletedFiles || 0,
  });
  
  const parts = [
    `${r.deletedItems || 0} items`,
    `${r.deletedFiles || 0} audio files`,
    `${r.deletedPodcasts || 0} podcast builds`,
    `${r.deletedProgress || 0} progress records`,
    `${r.deletedDomainCache || 0} domain cache entries`,
  ];
  const stopMsg = r.buildWasRunning ? '\n⚠️ An in-progress build was stopped.' : '';
  
  alert(`Cleanup complete:\n${parts.join('\n')}${stopMsg}`);

  window.location.reload(); 
});

/* ---------- Utils ---------- */
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- Boot ---------- */
async function bootstrapAuth() {
  try {
    const me = await api.get('/auth/me');
    if (me?.user?.id) {
      setAuthed(me.user);
      await loadToday();
      startProgressLoop();
      return;
    }
  } catch (e) {}
  showLogin();
}

bootstrapAuth();
