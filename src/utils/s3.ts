import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../config/env';

const region = env.AWS_REGION || 'us-east-1';
const bucketName = env.AWS_S3_BUCKET || 'wellmindly-assets';

// Initialize S3 client using environment credentials or default provider chain
const s3Client = new S3Client({
  region,
  ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});

/**
 * Whether uploads are written to (and assets read from) S3.
 *
 * Uploads used to reach S3 only when static AWS_ACCESS_KEY_ID/SECRET were set. On Elastic
 * Beanstalk credentials come from the instance role instead, so profile pictures were
 * written only to the instance's local disk (/var/app/current/uploads), which is replaced on
 * every deploy and not shared between instances: the stored avatarUrl then 404s.
 * Now S3 is used whenever static keys exist OR we run in production (default credential
 * chain = instance role). S3_UPLOADS=true/false overrides either way.
 */
export function isS3Enabled(): boolean {
  const flag = process.env.S3_UPLOADS?.trim().toLowerCase();
  if (flag === 'true' || flag === '1') return true;
  if (flag === 'false' || flag === '0') return false;
  return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) || process.env.NODE_ENV === 'production';
}

export interface UploadResult {
  url: string;
  key: string;
}

/**
 * Upload a binary buffer to AWS S3 bucket `wellmindly-assets`
 *
 * @param buffer - File contents as a Buffer
 * @param originalName - Original filename (e.g. avatar.png)
 * @param mimeType - File MIME type (e.g. image/png, image/jpeg)
 * @param folder - Destination folder prefix in bucket (defaults to 'avatars')
 */
import fs from 'fs';
import path from 'path';

export async function uploadToS3(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  folder = 'avatars'
): Promise<UploadResult> {
  const safeName = (originalName || `avatar_${Date.now()}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
  // The folder becomes part of a filesystem path below, so it must never
  // carry separators or dots ("../../src" used to be accepted from clients).
  folder = String(folder || 'avatars').replace(/[^a-zA-Z0-9_-]/g, '') || 'avatars';
  const timestamp = Date.now();
  const key = `${folder}/${timestamp}-${safeName}`;

  // Always save locally to uploads/ as reliable local storage & fallback across working directories
  const candidateDirs = [
    path.join(process.cwd(), 'uploads', folder),
    path.join(process.cwd(), 'backend', 'uploads', folder),
    path.resolve(__dirname, '../../../uploads', folder),
    path.resolve(__dirname, '../../uploads', folder),
  ];

  for (const localDir of candidateDirs) {
    try {
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }
      const localFilePath = path.join(localDir, `${timestamp}-${safeName}`);
      fs.writeFileSync(localFilePath, buffer);
    } catch {
      // Ignore if one candidate path is not accessible
    }
  }

  // Use the public proxy endpoint so direct S3 private permissions never block browsers
  const proxyUrl = `/api/v1/counselors/assets/${key}`;

  // Durable copy in S3: local disk does not survive a redeploy (see isS3Enabled).
  if (isS3Enabled()) {
    try {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      });

      await s3Client.send(command);
      console.log(`✅ Uploaded file to S3: ${key}`);
    } catch (error) {
      // Still served from this instance's disk, but only until the next deploy. If this
      // shows up in production, give the EB instance role s3:PutObject/GetObject on the bucket.
      console.error(`❌ S3 upload failed for key '${key}' (bucket ${bucketName}); kept on local disk only:`, error);
    }
  }

  return {
    url: proxyUrl,
    key,
  };
}

/**
 * Fetch an object directly from S3 using AWS SDK
 */
export async function getS3Object(key: string): Promise<{ body: any; contentType?: string } | null> {
  if (!isS3Enabled()) return null;
  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });
    const res = await s3Client.send(command);
    return {
      body: res.Body,
      contentType: res.ContentType,
    };
  } catch (error) {
    // A missing key is an ordinary 404 (stale avatarUrl); only log real failures.
    const name = (error as { name?: string })?.name;
    if (name !== 'NoSuchKey' && name !== 'NotFound') {
      console.error(`❌ Failed to get S3 object '${key}':`, error);
    }
    return null;
  }
}
