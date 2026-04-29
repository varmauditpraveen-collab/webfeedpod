const express = require('express');
const tts = require('../services/tts');

const router = express.Router();

router.get('/voices', async (req, res) => {
  try {
    res.json({ voices: await tts.listVoices() });
  } catch (e) {
    res.status(502).json({ error: e.message, voices: [] });
  }
});

router.get('/health', async (req, res) => {
  res.json(await tts.health());
});

// Quick "smoke test" for debugging — POST {text, voice} and play back the result.
router.post('/test', async (req, res) => {
  try {
    const out = await tts.synthesize(
      req.body.text || 'Hello from the news reader.',
      req.body.voice || 'af_heart',
      'smoke-test'
    );
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
