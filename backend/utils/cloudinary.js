const cloudinary = require('cloudinary').v2;

/**
 * Central Cloudinary config. Supports either:
 *   CLOUDINARY_URL=cloudinary://<key>:<secret>@<cloud_name>   (Cloudinary's own format — the SDK reads this env var automatically)
 * or the three separate vars:
 *   CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
 * See CLOUDINARY_SETUP.md for exact steps.
 */
const configured = !!(
  process.env.CLOUDINARY_URL ||
  (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
);

if (configured && !process.env.CLOUDINARY_URL) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}
if (!configured) {
  console.warn('[CLOUDINARY] Not configured (CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET missing) — image uploads will stay as inline base64 until this is set. See CLOUDINARY_SETUP.md.');
}

/**
 * Uploads a base64 data-URI ("data:image/png;base64,...") to Cloudinary and
 * returns the resulting secure_url. Anything that is NOT a base64 data-URI
 * (already a URL, empty string, undefined) is returned unchanged — this
 * makes the function safe to call unconditionally on every image field,
 * whether it's a brand-new upload from the admin UI or an already-migrated
 * Cloudinary URL from a previous save.
 */
async function uploadIfBase64(value, folder) {
  if (!value || typeof value !== 'string' || !value.startsWith('data:')) return value;
  if (!configured) return value; // no credentials yet — leave as base64, don't crash the save
  const r = await cloudinary.uploader.upload(value, {
    folder: folder || 'aiits',
    resource_type: 'image',
    // Keeps payload/storage sane — question images don't need to be huge;
    // this caps the longest edge without visibly degrading exam readability.
    transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto:good' }],
  });
  return r.secure_url;
}

/** Uploads a raw Buffer (e.g. from multer memoryStorage) — used for ad images. */
function uploadBuffer(buffer, folder) {
  return new Promise((resolve, reject) => {
    if (!configured) return reject(new Error('Cloudinary is not configured — set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET (see CLOUDINARY_SETUP.md)'));
    const stream = cloudinary.uploader.upload_stream(
      { folder: folder || 'aiits', resource_type: 'image', transformation: [{ width: 1920, height: 1920, crop: 'limit', quality: 'auto:good' }] },
      (err, result) => (err ? reject(err) : resolve(result.secure_url))
    );
    stream.end(buffer);
  });
}

/** Recursively uploads every base64 questionImage/option.imageData in a test's
 *  question list, mutating nothing — returns a NEW questions array. Call this
 *  once, right before Test.create()/Test.update(), on req.body.questions. */
async function uploadTestImages(questions) {
  if (!Array.isArray(questions)) return questions;
  return Promise.all(questions.map(async (q) => {
    const questionImage = await uploadIfBase64(q.questionImage, 'aiits/questions');
    const options = await Promise.all((q.options || []).map(async (o) => ({
      ...o,
      imageData: await uploadIfBase64(o.imageData, 'aiits/questions'),
    })));
    return { ...q, questionImage, options };
  }));
}

module.exports = { configured, uploadIfBase64, uploadBuffer, uploadTestImages };
