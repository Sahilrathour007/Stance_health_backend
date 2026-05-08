const { z } = require('zod');
const { anonClient, adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['patient', 'doctor', 'admin']).default('patient'),
  phone: z.string().optional(),
  specialization: z.string().optional()
});

async function register(req, res) {
  const body = registerSchema.parse(req.body);
  let createdNewAuthUser = false;
  let authUserId = null;

  let { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    user_metadata: { name: body.name, role: body.role }
  });

  if (!createError) {
    createdNewAuthUser = true;
    authUserId = created.user.id;
  } else if (String(createError.message).toLowerCase().includes('already')) {
    // User already exists in auth — find them and verify they have a matching profile.
    // We do NOT silently update their password (security: anyone could hijack an account by re-registering).
    const { data: listed, error: listError } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listError) throw httpError(400, createError.message, createError);
    const existing = listed.users.find((u) => u.email?.toLowerCase() === body.email.toLowerCase());
    if (!existing) throw httpError(400, createError.message, createError);

    // Check if a full profile already exists for this user
    const { data: existingProfile } = await adminClient.from('users').select('id').eq('id', existing.id).maybeSingle();
    if (existingProfile) {
      // Account fully registered — require them to log in instead
      throw httpError(409, 'An account with this email already exists. Please log in.');
    }

    // Auth user exists but no profile yet (partial registration) — safe to continue
    authUserId = existing.id;
    created = { user: existing };
    createError = null;
  }

  if (createError) throw httpError(400, createError.message, createError);

  try {
    const { data: profile, error: profileError } = await adminClient
      .from('users')
      .upsert({
        id: created.user.id,
        name: body.name,
        email: body.email,
        phone: body.phone || null,
        role: body.role
      }, { onConflict: 'id' })
      .select('*')
      .single();
    if (profileError) throw profileError;

    let roleProfile = null;
    if (body.role === 'patient') {
      const { data, error } = await adminClient
        .from('patients')
        .upsert({
          user_id: created.user.id,
          status: 'onboarding',
          current_risk_level: 'low'
        }, { onConflict: 'user_id' })
        .select('*')
        .single();
      if (error) throw error;
      roleProfile = data;
    }

    if (body.role === 'doctor') {
      const { data, error } = await adminClient
        .from('doctors')
        .upsert({
          user_id: created.user.id,
          specialization: body.specialization || null
        }, { onConflict: 'user_id' })
        .select('*')
        .single();
      if (error) throw error;
      roleProfile = data;
    }

    const { data: loginData, error: loginError } = await anonClient.auth.signInWithPassword({
      email: body.email,
      password: body.password
    });
    if (loginError) throw loginError;

    res.status(201).json({ session: loginData.session, user: profile, roleProfile });
  } catch (err) {
    if (createdNewAuthUser && authUserId) await adminClient.auth.admin.deleteUser(authUserId);
    throw httpError(400, 'Unable to create user profile', err);
  }
}

async function login(req, res) {
  const body = z.object({
    email: z.string().email(),
    password: z.string().min(1)
  }).parse(req.body);

  const { data, error } = await anonClient.auth.signInWithPassword(body);
  if (error) throw httpError(401, error.message, error);

  const { data: profile, error: profileError } = await adminClient
    .from('users')
    .select('*')
    .eq('id', data.user.id)
    .single();
  if (profileError) throw httpError(500, 'Unable to load user profile', profileError);

  res.json({ session: data.session, user: profile });
}

async function me(req, res) {
  res.json({
    authUser: req.authUser,
    user: req.userProfile
  });
}

module.exports = {
  register,
  login,
  me
};