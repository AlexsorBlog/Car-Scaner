/**
 * utils/compressImage.js
 *
 * Downscales + re-encodes a photo client-side before it's uploaded to
 * /api/chat. This is the single biggest lever on both upload bandwidth and
 * OpenAI Vision cost (token cost scales with image resolution) — running it
 * costs nothing (pure canvas work) but can cut a multi-MB camera photo down
 * to a few hundred KB with no visible quality loss for AI analysis.
 *
 * Accepts a File/Blob or a URL string (e.g. Capacitor Camera's `webPath`).
 */
export async function compressImage(source, { maxDimension = 1024, quality = 0.7 } = {}) {
  const isUrl = typeof source === 'string';
  const url = isUrl ? source : URL.createObjectURL(source);

  try {
    const img = await loadImage(url);
    const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
    const width  = Math.max(1, Math.round(img.width  * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);

    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/jpeg', quality)
    );
    return blob;
  } finally {
    if (!isUrl) URL.revokeObjectURL(url);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}
