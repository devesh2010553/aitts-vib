const crypto = require('crypto');
const sharp = require('sharp');
const { PDFParse } = require('pdf-parse');

/**
 * Local PDF extraction — text layer, page rasterization, embedded images,
 * and table detection, all via pdf-parse v2's built-in methods (getText/
 * getScreenshot/getImage/getTable). Deliberately NOT shelling out to system
 * binaries (poppler's pdftoppm/pdfimages) despite those being available in
 * this dev sandbox — there's no guarantee they're installed on the actual
 * Render deploy host, and a pure-npm dependency is far safer to rely on in
 * production. This is the "local/programmatic extraction first" step from
 * the spec (#9) — only the output of this module (per-page text + rendered
 * page images + extracted embedded images) is ever sent to the AI provider,
 * never the raw PDF.
 */

async function extractPdf(pdfBuffer) {
  const parser = new PDFParse({ data: pdfBuffer });
  try {
    const info = await parser.getInfo();
    const pageCount = info.total ?? info.numpages ?? 0;

    const [textResult, screenshotResult, imageResult, tableResult] = await Promise.all([
      parser.getText().catch(() => ({ pages: [] })),
      // Lower scale than you might reach for by default on purpose — every
      // pixel here becomes vision tokens once a page image is actually sent
      // (see aiProvider.js's needsImage logic), and Groq's free tier has a
      // real per-minute token ceiling. 1.0 is legible enough for OCR/layout
      // while keeping token cost per image well bounded; raise it back up if
      // you're on a paid tier and image quality is limiting extraction accuracy.
      parser.getScreenshot({ scale: 1.0 }).catch(() => ({ pages: [] })),
      parser.getImage({ imageThreshold: 60 }).catch(() => ({ pages: [] })), // skip small decorative artifacts, not real diagrams
      parser.getTable().catch(() => ({ pages: [] })),
    ]);

    const textByPage = (textResult.pages || []).map(p => (p.text || '').trim());

    const pageImages = {}; // { pageNumber: base64 PNG }
    for (const p of (screenshotResult.pages || [])) {
      const pageNum = p.pageNumber ?? p.num;
      const buf = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data);
      pageImages[pageNum] = buf.toString('base64');
    }

    // Flatten into { index, page, base64, bytes } — a stable sequential index
    // is what aiProvider.js references back ("Embedded image #N") so the AI
    // never has to echo image bytes, only point at a number.
    const embeddedImages = [];
    let idx = 0;
    for (const p of (imageResult.pages || [])) {
      const pageNum = p.pageNumber ?? p.num;
      for (const img of (p.images || [])) {
        const buf = Buffer.isBuffer(img.data) ? img.data : Buffer.from(img.data);
        embeddedImages.push({ index: idx++, page: pageNum, base64: buf.toString('base64'), bytes: buf.length });
      }
    }

    const tableCount = (tableResult.pages || []).reduce((s, p) => s + (p.tables || []).length, 0);

    // A page counts as "scanned" (spec #8) if it has effectively no
    // extractable text — the signal that the AI needs the rendered page
    // IMAGE (vision) for that page rather than working from text alone.
    const scannedPages = [];
    for (let i = 0; i < pageCount; i++) {
      if ((textByPage[i] || '').length < 20) scannedPages.push(i + 1);
    }

    return { pageCount, textByPage, pageImages, embeddedImages, scannedPages, tableCount };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Builds the exact same shape extractPdf() returns, but from a set of
 * ordinary image files (JPG/PNG/WEBP/etc — a phone photo of each page of a
 * question paper, in order) instead of a PDF. This is what lets the AI PDF
 * import pipeline accept "every format like jpg/jpeg/png" — importQueue.js
 * and aiProvider.js downstream never need to know the source wasn't a PDF;
 * they just see pageCount pages, each with a rendered image and no text
 * layer.
 *
 * Every image is treated as fully "scanned" (no extractable text layer) —
 * there IS no OCR text to pull out of a phone photo the way pdf-parse pulls
 * text out of a real PDF's text layer, so vision is the only way to read
 * it, same as a scanned PDF page. sharp's .rotate() with no arguments reads
 * the image's EXIF orientation tag and auto-corrects it — important for
 * phone camera photos, which are very often stored sideways/upside-down
 * relative to how they look on screen.
 */
async function extractFromImages(buffers) {
  const pageCount = buffers.length;
  const textByPage = new Array(pageCount).fill('');
  const pageImages = {};
  const scannedPages = [];

  for (let i = 0; i < pageCount; i++) {
    const pageNum = i + 1;
    try {
      const png = await sharp(buffers[i]).rotate().png().toBuffer();
      pageImages[pageNum] = png.toString('base64');
    } catch (e) {
      // A single corrupt/unsupported image shouldn't fail the whole job —
      // flag it as scanned-with-no-image so the AI batch for that page
      // fails gracefully (per-page failure handling already exists in
      // importQueue.js) instead of throwing here and losing every page.
      console.error(`[AI-IMPORT] Could not decode image for page ${pageNum}:`, e.message);
    }
    scannedPages.push(pageNum);
  }

  return { pageCount, textByPage, pageImages, embeddedImages: [], scannedPages, tableCount: 0 };
}

module.exports = { extractPdf, extractFromImages, sha256 };
