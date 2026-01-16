import type { RequestHandler } from 'express';
import { jwtVerify } from 'jose';
import { config } from './config.js';
import { supabaseAdmin } from './supabase.js';

export type AdminContext = {
  userId: string;
  email?: string;
};

declare module 'express-serve-static-core' {
  interface Request {
    admin?: AdminContext;
  }
}

const bearerTokenFromHeader = (header: string | undefined) => {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
};

const isAdminByEmail = (email?: string) => {
  if (!email) return false;
  return config.adminEmailAllowlist.has(email.toLowerCase());
};

const isAdminBySupabaseTable = async (userId: string) => {
  if (!supabaseAdmin) return false;
  const { data, error } = await supabaseAdmin
    .from('admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.user_id);
};

export const requireAdmin: RequestHandler = async (req, res, next) => {
  try {
    const token = bearerTokenFromHeader(req.header('authorization'));
    if (!token) {
      return res.status(401).json({ error: 'missing_bearer_token' });
    }

    if (config.ADMIN_API_KEY && token === config.ADMIN_API_KEY) {
      req.admin = { userId: 'api_key' };
      return next();
    }

    if (!config.SUPABASE_JWT_SECRET) {
      return res.status(500).json({ error: 'server_missing_supabase_jwt_secret' });
    }

    const secret = new TextEncoder().encode(config.SUPABASE_JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256']
    });

    const userId = typeof payload.sub === 'string' ? payload.sub : null;
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    if (!userId) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    const isAdmin = isAdminByEmail(email) || (await isAdminBySupabaseTable(userId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'not_admin' });
    }

    req.admin = { userId, email };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_token' });
  }
};
