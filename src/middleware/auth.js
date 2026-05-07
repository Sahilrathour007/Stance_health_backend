const { adminClient, createUserClient } = require('../config/supabase');
const httpError = require('../utils/httpError');

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

async function requireAuth(req, _res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) throw httpError(401, 'Missing bearer token');

    const { data, error } = await adminClient.auth.getUser(token);
    if (error || !data.user) throw httpError(401, 'Invalid or expired token');

    const { data: profile, error: profileError } = await adminClient
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .maybeSingle();

    if (profileError) throw httpError(500, 'Unable to load user profile', profileError);
    if (!profile) throw httpError(403, 'User profile is missing in public.users');

    req.authToken = token;
    req.authUser = data.user;
    req.userProfile = profile;
    req.supabase = createUserClient(token);
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...allowedRoles) {
  return function roleMiddleware(req, _res, next) {
    if (!req.userProfile) return next(httpError(401, 'Authentication required'));
    if (!allowedRoles.includes(req.userProfile.role)) {
      return next(httpError(403, `Requires role: ${allowedRoles.join(' or ')}`));
    }
    return next();
  };
}

module.exports = {
  requireAuth,
  requireRole
};
