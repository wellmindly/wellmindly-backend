"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadToS3 = uploadToS3;
exports.getS3Object = getS3Object;
const client_s3_1 = require("@aws-sdk/client-s3");
const env_1 = require("../config/env");
const region = env_1.env.AWS_REGION || 'us-east-1';
const bucketName = env_1.env.AWS_S3_BUCKET || 'wellmindly-assets';
// Initialize S3 client using environment credentials or default provider chain
const s3Client = new client_s3_1.S3Client({
    region,
    ...(env_1.env.AWS_ACCESS_KEY_ID && env_1.env.AWS_SECRET_ACCESS_KEY
        ? {
            credentials: {
                accessKeyId: env_1.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: env_1.env.AWS_SECRET_ACCESS_KEY,
            },
        }
        : {}),
});
/**
 * Upload a binary buffer to AWS S3 bucket `wellmindly-assets`
 *
 * @param buffer - File contents as a Buffer
 * @param originalName - Original filename (e.g. avatar.png)
 * @param mimeType - File MIME type (e.g. image/png, image/jpeg)
 * @param folder - Destination folder prefix in bucket (defaults to 'avatars')
 */
async function uploadToS3(buffer, originalName, mimeType, folder = 'avatars') {
    const safeName = (originalName || `avatar_${Date.now()}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const timestamp = Date.now();
    const key = `${folder}/${timestamp}-${safeName}`;
    try {
        const command = new client_s3_1.PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: buffer,
            ContentType: mimeType,
        });
        await s3Client.send(command);
        const publicUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
        console.log(`✅ Uploaded file to S3: ${publicUrl}`);
        return {
            url: publicUrl,
            key,
        };
    }
    catch (error) {
        console.error(`❌ S3 Upload failed for key '${key}':`, error);
        // If S3 fails, fallback to base64 Data URI so counselor image still displays
        if (buffer.length < 3 * 1024 * 1024) {
            const dataUrl = `data:${mimeType || 'image/png'};base64,${buffer.toString('base64')}`;
            return {
                url: dataUrl,
                key,
            };
        }
        const fallbackUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
        return {
            url: fallbackUrl,
            key,
        };
    }
}
/**
 * Fetch an object directly from S3 using AWS SDK
 */
async function getS3Object(key) {
    try {
        const command = new client_s3_1.GetObjectCommand({
            Bucket: bucketName,
            Key: key,
        });
        const res = await s3Client.send(command);
        return {
            body: res.Body,
            contentType: res.ContentType,
        };
    }
    catch (error) {
        console.error(`❌ Failed to get S3 object '${key}':`, error);
        return null;
    }
}
