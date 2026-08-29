const cloudinary = require('cloudinary').v2;

/**
 * Central image-storage helper. Replaces the old pattern of embedding
 * `data:image/...;base64,...` directly in documents.
 *
 * Why this had to change: Test now lives on DynamoDB (see ../dynamo/testModel.js),
 * and DynamoDB hard-caps a single item at 400 KB. A base64-embedded
 * questionImage/option image alone is routinely 100-500KB+ as text, so any
 * test with even a couple of images would fail to save (or silently blow up
 * item size) the moment it moved off Mongo's 16MB-document world. Uploading
 * to Cloudinary and storing only the short secure_url string sidesteps that
 * entirely, and also drops AdImage's document weight on MongoDB.
 *
 * Configure via a single CLOUDINARY_URL env var (cloudinary://key:secret@cloud_name,
 * the format Cloudinary's dashboard gives you directly), or the three
 * separate CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
 * vars — either works, the SDK reads CLOUDINARY_URL automatically and the
 * explicit .config() call below only fires if that's not set.
 */
if (!process.env.CLOUDINARY_URL && process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

function isConfigured() {
  const c = cloudinary.config();
  return !!(c.cloud_name && c.api_key && c.api_secret);
}

/** Upload a Buffer (e.g. from multer memoryStorage) and return the secure_url. */
function uploadBuffer(buffer, folder) {
  if (!isConfigured()) return Promise.reject(new Error('Cloudinary is not configured on this server (missing CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET).'));
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder, resource_type: 'image' }, (err, result) => {
      if (err) return reject(err);
      resolve(result.secure_url);
    });
    stream.end(buffer);
  });
}

/** Upload a `data:image/...;base64,...` data URI and return the secure_url. */
async function uploadDataUri(dataUri, folder) {
  if (!isConfigured()) throw new Error('Cloudinary is not configured on this server (missing CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET).');
  const result = await cloudinary.uploader.upload(dataUri, { folder, resource_type: 'image' });
  return result.secure_url;
}

/** True for a `data:image/...;base64,...` string — the marker that an image still needs uploading, vs. already being a Cloudinary (or other) URL. */
function isDataUri(s) {
  return typeof s === 'string' && s.startsWith('data:image/');
}

/** Best-effort delete by full Cloudinary URL — used when an admin replaces/removes an image, to avoid orphaning storage. Never throws; a failed cleanup shouldn't fail the request that triggered it. */
async function destroyByUrl(url) {
  try {
    if (!isConfigured() || typeof url !== 'string') return;
    const m = url.match(/\/upload\/(?:v\d+\/)?([^.]+)\.[a-zA-Z0-9]+$/);
    if (!m) return;
    await cloudinary.uploader.destroy(m[1], { resource_type: 'image' });
  } catch (e) { /* best-effort, never block the caller */ }
}

module.exports = { cloudinary, isConfigured, uploadBuffer, uploadDataUri, isDataUri, destroyByUrl };
