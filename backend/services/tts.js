const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Pull URL and Token from Railway environment variables
const KOKORO_URL = process.env.KOKORO_URL || 'http://localhost:8001';
const HF_TOKEN = process.env.HF_TOKEN || null;

const AUDIO_DIR = path.join(__dirname, '..', 'storage', 'audio');
const MAX_CHUNK_CHARS = 500;       // safe under Kokoro's per-pass token cap

if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Helper function to dynamically attach Hugging Face auth headers if a token exists
function getHeaders() {
  const headers = {};
  if (HF_TOKEN) {
    headers['Authorization'] = `Bearer ${HF_TOKEN}`;
  }
  return headers;
}

async function listVoices() {
  // Bumped timeout to 30s to account for Hugging Face cold starts
  const res = await axios.get(`${KOKORO_URL}/voices`, { 
    headers: getHeaders(),
    timeout: 30000 
  });
  return res.data?.voices || [];
}

async function health() {
  try {
    // Bumped timeout to 15s to account for Hugging Face cold starts
    const res = await axios.get(`${KOKORO_URL}/health`, { 
      headers: getHeaders(),
      timeout: 15000 
    });
    return res.data || { ok: true };
  } catch (e) {
    return { ok: false, error: friendlyAxiosError(e) };
  }
}

/** Strip markdown, HTML tags, code fences, links, and weird chars that confuse TTS. */
function sanitizeForTts(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/```[\s\S]*?```/g, ' ');                    // code fences
  s = s.replace(/`([^`]+)`/g, '$1');                          // inline code
  s = s.replace(/<[^>]+>/g, ' ');                              // html tags
  s = s.replace(/!\[[^\]]*\]\([^)]+\)/g, ' ');                // markdown images
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');              // markdown links -> text
  s = s.replace(/https?:\/\/\S+/g, ' ');                       // bare URLs
  s = s.replace(/[#*_>~`|]+/g, ' ');                           // markdown punctuation
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ');  // control chars
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Split text into ~MAX_CHUNK_CHARS pieces at sentence/clause boundaries. */
function chunkText(text, max = MAX_CHUNK_CHARS) {
  text = sanitizeForTts(text);
  if (!text) return [];
  if (text.length <= max) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + ' ' + s).trim().length <= max) {
      buf = (buf ? buf + ' ' : '') + s;
    } else {
      if (buf) chunks.push(buf);
      if (s.length <= max) buf = s;
      else {
        // hard split overlong "sentence" on commas / spaces
        const parts = s.split(/(?<=,)\s+|\s(?=[A-Z])/);
        let inner = '';
        for (const p of parts) {
          if ((inner + ' ' + p).trim().length <= max) inner = (inner ? inner + ' ' : '') + p;
          else { if (inner) chunks.push(inner); inner = p.slice(0, max); }
        }
        buf = inner;
      }
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function friendlyAxiosError(e) {
  if (!e) return 'unknown';
  if (e.response) {
    // Try to surface the real sidecar error even when responseType is arraybuffer.
    let body = e.response.data;
    try {
      if (Buffer.isBuffer(body)) body = body.toString('utf8');
      if (typeof body === 'string' && body.startsWith('{')) {
        const j = JSON.parse(body);
        if (j.error) return `kokoro ${e.response.status}: ${j.error}`;
      }
      if (typeof body === 'object' && body?.error) return `kokoro ${e.response.status}: ${body.error}`;
    } catch {}
    return `kokoro ${e.response.status}`;
  }
  if (e.code === 'ECONNREFUSED') return `cannot reach KOKORO_URL=${KOKORO_URL} (API down?)`;
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED') return 'kokoro timeout';
  return e.message || String(e);
}

async function postOnce(text, voice) {
  return axios.post(
    `${KOKORO_URL}/tts`,
    { text, voice: voice || 'af_heart' },
    { 
      headers: getHeaders(),
      responseType: 'arraybuffer', 
      timeout: 180000, 
      validateStatus: (s) => s >= 200 && s < 300 
    }
  );
}

/** Concatenate multiple PCM-16 mono WAV buffers (same sample rate) into one. */
function concatWavBuffers(bufs) {
  if (bufs.length === 0) return Buffer.alloc(0);
  if (bufs.length === 1) return bufs[0];
  const first = bufs[0];
  if (first.slice(0, 4).toString() !== 'RIFF') return first; // bail if not WAV
  const sampleRate = first.readUInt32LE(24);
  const numChannels = first.readUInt16LE(22);
  const bitsPerSample = first.readUInt16LE(34);

  const dataChunks = [];
  for (const b of bufs) {
    // Find 'data' chunk to support files with extra chunks (LIST/INFO).
    let i = 12;
    while (i < b.length - 8) {
      const id = b.slice(i, i + 4).toString();
      const size = b.readUInt32LE(i + 4);
      if (id === 'data') {
        dataChunks.push(b.slice(i + 8, i + 8 + size));
        break;
      }
      i += 8 + size + (size % 2);
    }
  }
  const totalData = dataChunks.reduce((n, c) => n + c.length, 0);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + totalData, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                       // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(totalData, 40);
  return Buffer.concat([header, ...dataChunks]);
}

/**
 * synthesize(text, voice, id?) -> { audioPath, durationSeconds, audioUrl }
 */
async function synthesize(text, voice, id) {
  const clean = sanitizeForTts(text);
  if (!clean) throw new Error('synthesize: empty text after sanitization');
  const fileId = id || crypto.createHash('sha1').update(`${voice}:${clean}`).digest('hex').slice(0, 16);
  const fileName = `${fileId}.wav`;
  const filePath = path.join(AUDIO_DIR, fileName);

  const chunks = chunkText(clean);
  const wavs = [];
  for (let idx = 0; idx < chunks.length; idx++) {
    const piece = chunks[idx];
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await postOnce(piece, voice);
        wavs.push(Buffer.from(res.data));
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (lastErr) {
      const reason = friendlyAxiosError(lastErr);
      const sample = piece.slice(0, 80).replace(/\s+/g, ' ');
      throw new Error(`tts failed on chunk ${idx + 1}/${chunks.length} ("${sample}…"): ${reason}`);
    }
  }

  const finalBuf = concatWavBuffers(wavs);
  fs.writeFileSync(filePath, finalBuf);
  const durationSeconds = wavDurationSeconds(filePath);
  return {
    audioPath: filePath,
    audioUrl: `/audio/${fileName}`,
    durationSeconds,
  };
}

function wavDurationSeconds(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(44);
    fs.readSync(fd, header, 0, 44, 0);
    fs.closeSync(fd);
    if (header.slice(0, 4).toString() !== 'RIFF') return 0;
    if (header.slice(8, 12).toString() !== 'WAVE') return 0;
    const sampleRate = header.readUInt32LE(24);
    const byteRate = header.readUInt32LE(28);
    const stat = fs.statSync(filePath);
    const dataBytes = stat.size - 44;
    if (byteRate > 0) return dataBytes / byteRate;
    if (sampleRate > 0) {
      const numChannels = header.readUInt16LE(22);
      const bitsPerSample = header.readUInt16LE(34);
      return dataBytes / (sampleRate * numChannels * (bitsPerSample / 8));
    }
    return 0;
  } catch { return 0; }
}

function deleteAudioFile(audioPathOrUrl) {
  if (!audioPathOrUrl) return false;
  let p = audioPathOrUrl;
  if (p.startsWith('/audio/')) p = path.join(AUDIO_DIR, path.basename(p));
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch { return false; }
}

module.exports = {
  listVoices, health, synthesize, deleteAudioFile,
  wavDurationSeconds, sanitizeForTts, chunkText, friendlyAxiosError,
  AUDIO_DIR,
};
