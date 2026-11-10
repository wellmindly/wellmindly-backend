import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../lib/jwt';
import { sendError } from '../utils/response';
import { Role } from '../generated/prisma/client';

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

export function authenticateJWT(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendError(res, 'UNAUTHORIZED', 'Missing or invalid authorization token header', 401);
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch (err: any) {
    sendError(res, 'INVALID_TOKEN', 'Token verification failed or token expired', 401);
    return;
  }
}

export function requireRoles(allowedRoles: Role[]) {
  // SUPER_ADMIN satisfies any ADMIN requirement (same rule as authorizeRoles).
  const roles: Role[] = allowedRoles.includes('ADMIN' as Role) && !allowedRoles.includes('SUPER_ADMIN' as Role)
    ? [...allowedRoles, 'SUPER_ADMIN' as Role]
    : allowedRoles;
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendError(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    if (!roles.includes(req.user.role as Role)) {
      sendError(
        res,
        'FORBIDDEN',
        `Access denied. Required roles: ${allowedRoles.join(', ')}`,
        403
      );
      return;
    }

    next();
  };
}
