"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
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
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
async function uploadToS3(buffer, originalName, mimeType, folder = 'avatars') {
    const safeName = (originalName || `avatar_${Date.now()}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const timestamp = Date.now();
    const key = `${folder}/${timestamp}-${safeName}`;
    // Always save locally to uploads/ as reliable local storage & fallback
    try {
        const localDir = path_1.default.join(process.cwd(), 'uploads', folder);
        if (!fs_1.default.existsSync(localDir)) {
            fs_1.default.mkdirSync(localDir, { recursive: true });
        }
        const localFilePath = path_1.default.join(localDir, `${timestamp}-${safeName}`);
        fs_1.default.writeFileSync(localFilePath, buffer);
        console.log(`✅ Saved local asset fallback to: ${localFilePath}`);
    }
    catch (localErr) {
        console.warn('⚠️ Could not save local asset copy:', localErr);
    }
    // Use the public proxy endpoint so direct S3 private permissions never block browsers
    const proxyUrl = `/api/v1/counselors/assets/${key}`;
    // If AWS credentials exist, also sync to S3 bucket
    if (env_1.env.AWS_ACCESS_KEY_ID && env_1.env.AWS_SECRET_ACCESS_KEY) {
        try {
            const command = new client_s3_1.PutObjectCommand({
                Bucket: bucketName,
                Key: key,
                Body: buffer,
                ContentType: mimeType,
            });
            await s3Client.send(command);
            console.log(`✅ Uploaded file to S3: ${key}`);
        }
        catch (error) {
            console.warn(`❌ S3 Upload failed for key '${key}', using local storage:`, error);
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
