import { Request, Response, NextFunction } from 'express';
import { verifyToken, signToken, JwtPayload } from '../lib/jwt';

// Re-export shared primitives so callers only need to import from one place
export { signToken, verifyToken, JwtPayload };

/**
 * Express middleware that validates the Bearer JWT in the Authorization header.
 *
 * On success:  populates req.user with { sub, email, role, universityId }
 *              and calls next().
 * On failure:  responds immediately with 401 Unauthorized.
 *
 * Usage:
 *   import { authenticateJWT } from '../utils/jwt';
 *   router.get('/protected', authenticateJWT, handler);
 */
export function authenticateJWT(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization header missing or malformed' });
    return;
  }

  const token = authHeader.slice(7); // strip "Bearer "

  try {
    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.name === 'TokenExpiredError') {
        res.status(401).json({ error: 'Token has expired' });
        return;
      }
      if (err.name === 'JsonWebTokenError') {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }
    }
    res.status(401).json({ error: 'Authentication failed' });
  }
}

/**
 * Role-guard factory, used after authenticateJWT.
 *
 * Usage:
 *   router.delete('/admin/user/:id', authenticateJWT, authorizeRoles('ADMIN'), handler);
 */
export function authorizeRoles(...allowedRoles: string[]) {
  // SUPER_ADMIN is a superset of ADMIN: anywhere ADMIN is allowed, so is it.
  // Many legacy routes list only 'ADMIN', which locked super admins out.
  const roles = allowedRoles.includes('ADMIN') && !allowedRoles.includes('SUPER_ADMIN')
    ? [...allowedRoles, 'SUPER_ADMIN']
    : allowedRoles;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Forbidden: insufficient permissions' });
      return;
    }
    next();
  };
}
