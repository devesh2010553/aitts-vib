const crypto = require('crypto');
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

module.exports = { extractPdf, sha256 };
