const express = require('express');
const router = express.Router();
const { runCleanup } = require('../services/cleanup');

// POST /api/cleanup/run -> Triggers the cleanup manually
router.post('/run', async (req, res) => {
  try {
    const result = await runCleanup(req.user.id);
    // Return the result directly so your frontend sees r.deletedItems, r.deletedFiles, etc.
    res.json(result); 
  } catch (error) {
    console.error('[cleanup API error]', error);
    res.status(500).json({ error: error.message });
  }
});

// THIS EXPORT FIXES YOUR CRASH
module.exports = router;
