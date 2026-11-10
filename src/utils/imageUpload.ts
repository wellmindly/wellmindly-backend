/**
 * Validation for the base64 image uploads (counselor avatar, invite-time
 * avatar, admin avatar upload).
 *
 * These endpoints used to store whatever they were sent: any MIME type (so an
 * SVG or HTML file with script in it was then served back from the API origin
 * by the public assets proxy), any size up to the 15 MB body limit, and any
 * `folder`, which went straight into a filesystem path (`../..` included).
 * The file type is now decided by the file's own magic bytes, not by the
 * client's mimeType or file name, and only raster image formats pass.
 */

export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;

// Upload folders a client may name. Everything the frontends send today is
// 'avatars'; anything else is coerced to it.
const ALLOWED_FOLDERS = new Set(['avatars']);

const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  {
    mime: 'image/png',
    ext: 'png',
    test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')) },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

export const SAFE_IMAGE_MIME_TYPES = new Set(SIGNATURES.map((s) => s.mime));

export type ImageUploadResult =
  | { ok: true; buffer: Buffer; fileName: string; mimeType: string; folder: string }
  | { ok: false; message: string };

export function parseImageUpload(body: any): ImageUploadResult {
  const { fileName, base64Data, folder } = body || {};

  if (!base64Data || typeof base64Data !== 'string') {
    return { ok: false, message: 'base64Data is required' };
  }

  const cleanBase64 = base64Data.includes('base64,') ? base64Data.split('base64,')[1] : base64Data;

  // Cheap pre-check on the encoded length before allocating the buffer.
  if (cleanBase64.length > Math.ceil((MAX_IMAGE_UPLOAD_BYTES * 4) / 3) + 4) {
    return { ok: false, message: 'Image is too large (maximum 5 MB)' };
  }

  const buffer = Buffer.from(cleanBase64, 'base64');
  if (buffer.length === 0) {
    return { ok: false, message: 'Uploaded file is empty or not valid base64' };
  }
  if (buffer.length > MAX_IMAGE_UPLOAD_BYTES) {
    return { ok: false, message: 'Image is too large (maximum 5 MB)' };
  }

  const kind = SIGNATURES.find((s) => s.test(buffer));
  if (!kind) {
    return { ok: false, message: 'Only PNG, JPEG, WebP or GIF images can be uploaded' };
  }

  // Keep a readable base name but force the extension to match the real type.
  const rawBase = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : `avatar_${Date.now()}`;
  const base = rawBase.replace(/\.[^./\\]*$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'avatar';

  const safeFolder = typeof folder === 'string' && ALLOWED_FOLDERS.has(folder) ? folder : 'avatars';

  return { ok: true, buffer, fileName: `${base}.${kind.ext}`, mimeType: kind.mime, folder: safeFolder };
}
