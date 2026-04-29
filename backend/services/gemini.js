const axios = require('axios');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

let lastGeminiCall = 0;
async function throttle() {
  const now = Date.now();
  const elapsed = now - lastGeminiCall;
  if (elapsed < 4000) await new Promise((r) => setTimeout(r, 4000 - elapsed));
  lastGeminiCall = Date.now();
}

function apiKey() { return process.env.GEMINI_API_KEY || ''; }

function endpoint() {
  return `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey()}`;
}

async function callGemini(prompt) {
  if (!apiKey()) throw new Error('GEMINI_API_KEY is not set');
  await throttle();
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.6 },
      };
      const res = await axios.post(endpoint(), payload, { timeout: 60000 });
      return res.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n') || '';
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (status === 503 || status === 429 || e.code === 'ECONNRESET') {
        const wait = 2000 * (attempt + 1);
        console.warn(`[gemini] ${status || e.code}, retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * introForItem — one "Next up..." sentence from title + description
 */
async function introForItem(item) {
  const prompt =
    `You are a podcast host. Write exactly ONE sentence starting with "Next up," ` +
    `that naturally introduces this story using the title and description. ` +
    `Read the description content naturally — don't just say "a story about". ` +
    `No markdown, no bullet points, just the raw spoken sentence.\n\n` +
    `TITLE: ${item.title}\n` +
    `SOURCE: ${item.feedTitle || ''}\n` +
    `DESCRIPTION: ${(item.description || '').slice(0, 400)}`;
  try {
    const raw = await callGemini(prompt);
    if (raw && typeof raw === 'string') return raw.trim();
  } catch (e) {
    console.warn(`[gemini] introForItem failed for "${item.title}": ${e.message}`);
  }
  return `Next up, ${item.title}.`;
}

module.exports = { introForItem };
