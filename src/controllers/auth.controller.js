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

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    user_metadata: { name: body.name, role: body.role }
  });
  if (createError) throw httpError(400, createError.message, createError);

  try {
    const { data: profile, error: profileError } = await adminClient
      .from('users')
      .insert({
        id: created.user.id,
        name: body.name,
        email: body.email,
        phone: body.phone || null,
        role: body.role
      })
      .select('*')
      .single();
    if (profileError) throw profileError;

    let roleProfile = null;
    if (body.role === 'patient') {
      const { data, error } = await adminClient
        .from('patients')
        .insert({
          user_id: created.user.id,
          status: 'onboarding',
          current_risk_level: 'low'
        })
        .select('*')
        .single();
      if (error) throw error;
      roleProfile = data;
    }

    if (body.role === 'doctor') {
      const { data, error } = await adminClient
        .from('doctors')
        .insert({
          user_id: created.user.id,
          specialization: body.specialization || null
        })
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
    await adminClient.auth.admin.deleteUser(created.user.id);
    throw httpError(400, 'Unable to create public user profile', err);
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
