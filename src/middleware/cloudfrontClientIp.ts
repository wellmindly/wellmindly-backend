import type { NextFunction, Request, Response } from 'express';
import { isIP } from 'net';

/**
 * api.wellmindly.com is behind CloudFront (then the ALB / nginx). CloudFront appends the
 * viewer's address to X-Forwarded-For, so the chain reaching Node is
 *   <spoofed...>, <viewer>, <CloudFront edge>, <ALB>
 * and Express' 'trust proxy' (loopback, uniquelocal) stops at the public edge address,
 * making req.ip a CloudFront edge IP shared by many users (one rate-limit bucket).
 *
 * For requests carrying CloudFront's own X-Amz-Cf-Id header, where Express resolved req.ip to
 * a public address (the edge), use the X-Forwarded-For entry immediately to its left: that
 * entry was appended by CloudFront itself, not by the client. Anything further left is ignored.
 *
 * Known limit: without a CloudFront range list the edge cannot be verified, so a caller that
 * reaches the ALB directly could send a fake X-Amz-Cf-Id. Restrict the ALB / security group
 * to the CloudFront origin-facing prefix list (com.amazonaws.global.cloudfront.origin-facing)
 * to close that. Set TRUST_CLOUDFRONT=false to turn this off.
 */
export function resolveCloudFrontClient(
  edgeIp: string | undefined,
  xForwardedFor: string | undefined,
  hasCfId: boolean
): string | undefined {
  if (!hasCfId || !edgeIp || !xForwardedFor) return undefined;
  const parts = xForwardedFor.split(',').map((s) => s.trim());
  const idx = parts.lastIndexOf(edgeIp);
  if (idx < 1) return undefined;
  const candidate = parts[idx - 1];
  return isIP(candidate) ? candidate : undefined;
}

export function cloudfrontClientIp(req: Request, _res: Response, next: NextFunction) {
  if (process.env.TRUST_CLOUDFRONT?.trim().toLowerCase() === 'false') return next();
  const cfId = req.headers['x-amz-cf-id'];
  const xff = req.headers['x-forwarded-for'];
  const client = resolveCloudFrontClient(
    req.ip,
    Array.isArray(xff) ? xff.join(',') : xff,
    typeof cfId === 'string' && cfId.length > 0
  );
  if (client) {
    Object.defineProperty(req, 'ip', { value: client, configurable: true, enumerable: true });
  }
  next();
}
