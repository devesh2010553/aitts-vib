const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { uploadBuffer } = require('../utils/cloudinary');
const SiteSetting = require('../models/SiteSetting');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const SETTING_KEYS = {
  profile:       'aboutPageProfileImageUrl',       // shown under "Hi, I'm Devesh" on the about page
  searchconsole: 'aboutPageSearchConsoleImageUrl',  // Search Console clicks-per-month screenshot
};

// Deliberately its OWN check, not authenticateAdmin from middleware/auth.js —
// this upload mode isn't part of the admin panel and shouldn't share its
// session/cookie. ABOUT_PAGE_UPLOAD_KEY is a separate secret set only in
// env; without it set, uploads are refused outright rather than silently
// left open.
function requireUploadKey(req, res, next) {
  const configured = process.env.ABOUT_PAGE_UPLOAD_KEY;
  if (!configured) return res.status(503).json({ error: 'Uploads not configured — set ABOUT_PAGE_UPLOAD_KEY in env first.' });
  const supplied = req.header('x-upload-key') || req.body.key || req.query.key || '';
  if (supplied !== configured) return res.status(401).json({ error: 'Wrong key.' });
  next();
}

// Public read — just two Cloudinary URLs (or empty strings), same trust
// level as the other /api/public/* reads elsewhere in this app. Needed by
// the about page's normal (non-upload) view.
router.get('/images', async (req, res) => {
  try {
    const [profile, sc] = await Promise.all([
      SiteSetting.findById(SETTING_KEYS.profile),
      SiteSetting.findById(SETTING_KEYS.searchconsole),
    ]);
    res.json({
      profileUrl:       profile ? profile.value : '',
      searchConsoleUrl: sc      ? sc.value      : '',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/upload', requireUploadKey, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded (field name: image)' });
    const type = SETTING_KEYS[req.body.type] ? req.body.type : null;
    if (!type) return res.status(400).json({ error: "type must be 'profile' or 'searchconsole'" });
    const url = await uploadBuffer(req.file.buffer, 'aiits/about-page/' + type);
    await SiteSetting.findByIdAndUpdate(SETTING_KEYS[type], { value: url }, { upsert: true });
    res.json({ url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
