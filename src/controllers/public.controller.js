const { z } = require('zod');
const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');

const profileSchema = z.object({
  first_name: z.string().trim().min(1),
  last_name: z.string().trim().optional().nullable(),
  email: z.string().trim().email().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  age: z.coerce.number().int().positive().optional().nullable(),
  activity_level: z.string().optional().nullable(),
  primary_concern: z.string().optional().nullable(),
  medical_history: z.string().optional().nullable()
});

const appointmentSchema = z.object({
  patient_id: z.string().uuid().optional().nullable(),
  patient_email: z.string().trim().email().optional().nullable(),
  patient_name: z.string().trim().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  program: z.string().optional().nullable(),
  physiotherapist: z.string().optional().nullable(),
  appointment_type: z.string().optional().nullable(),
  appointment_date: z.string().optional().nullable(),
  appointment_time: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  status: z.string().optional().nullable()
});

function fullName(body) {
  return [body.first_name, body.last_name].filter(Boolean).join(' ').trim();
}

function appointmentType(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('initial') || text.includes('assessment')) return 'initial';
  if (text.includes('urgent')) return 'urgent';
  if (text.includes('discharge')) return 'discharge';
  return 'follow_up';
}

async function findPatientByContact({ patient_id, patient_email, phone }) {
  if (patient_id) {
    const { data, error } = await adminClient.from('patients').select('*').eq('id', patient_id).maybeSingle();
    if (error) throw httpError(500, 'Unable to load patient', error);
    if (data) return data;
  }

  if (patient_email || phone) {
    let userQuery = adminClient.from('users').select('*').limit(1);
    userQuery = patient_email ? userQuery.eq('email', patient_email) : userQuery.eq('phone', phone);
    const { data: user, error: userError } = await userQuery.maybeSingle();
    if (userError) throw httpError(500, 'Unable to load user by contact', userError);
    if (user) {
      const { data: patient, error: patientError } = await adminClient
        .from('patients')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (patientError) throw httpError(500, 'Unable to load patient by user', patientError);
      if (patient) return patient;
    }
  }

  return null;
}

async function createMinimalPatientFromAppointment(body) {
  const name = body.patient_name || 'New patient';
  const email = body.patient_email || `patient-${Date.now()}-${Math.random().toString(16).slice(2)}@stance.local`;

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { name, phone: body.phone || null, role: 'patient' }
  });
  if (createError) throw httpError(400, createError.message, createError);

  const { data: user, error: userError } = await adminClient
    .from('users')
    .insert({
      id: created.user.id,
      name,
      email: body.patient_email || null,
      phone: body.phone || null,
      role: 'patient',
      is_active: true
    })
    .select('*')
    .single();
  if (userError) throw httpError(500, 'Unable to create appointment user', userError);

  const { data: patient, error: patientError } = await adminClient
    .from('patients')
    .insert({
      user_id: user.id,
      pain_location: body.program || null,
      status: 'onboarding',
      current_risk_level: 'low'
    })
    .select('*')
    .single();
  if (patientError) throw httpError(500, 'Unable to create appointment patient', patientError);
  return patient;
}

async function savePublicProfile(req, res) {
  const body = profileSchema.parse(req.body);
  const name = fullName(body);

  let authUserId = null;
  let existingPublicUser = null;
  if (body.email) {
    const { data, error } = await adminClient
      .from('users')
      .select('*')
      .eq('email', body.email)
      .maybeSingle();
    if (error) throw httpError(500, 'Unable to check existing user profile', error);
    existingPublicUser = data;
    authUserId = data?.id || null;
  }

  if (body.email) {
    if (!authUserId) {
      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email: body.email,
        email_confirm: true,
        user_metadata: { name, role: 'patient' }
      });
      if (createError) {
        const msg = String(createError.message).toLowerCase();
        if (!msg.includes('already registered') && !msg.includes('already been registered') && !msg.includes('already exists')) {
          throw httpError(400, createError.message, createError);
        }
        // User already in auth.users — fetch their UUID so we can still create/link public.users
        const { data: userList } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
        const found = (userList?.users || []).find(u => u.email === body.email);
        authUserId = found?.id || null;
      } else {
        authUserId = created?.user?.id || null;
      }
    }
  }

  if (!authUserId && !body.email) {
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email: `patient-${Date.now()}-${Math.random().toString(16).slice(2)}@stance.local`,
      email_confirm: true,
      user_metadata: { name, phone: body.phone || null, role: 'patient' }
    });
    if (createError) throw httpError(400, createError.message, createError);
    authUserId = created.user.id;
  }

  let user = existingPublicUser;
  if (authUserId) {
    // Never allow name to be null — public.users has NOT NULL on name column
    const safeName = name || body.email?.split('@')[0] || 'Patient';
    const { data, error } = await adminClient
      .from('users')
      .upsert({
        id: authUserId,
        name: safeName,
        email: body.email || null,
        phone: body.phone || null,
        role: 'patient',
        is_active: true
      }, { onConflict: 'id' })
      .select('*')
      .single();
    if (error) throw httpError(500, 'Unable to save user profile', error);
    user = data;
  }

  // Guard: if we still have no user.id, we cannot create a patient row with a valid FK
  if (!user?.id) {
    throw httpError(500, 'Failed to establish user identity — cannot create patient profile');
  }

  const patientPayload = {
    user_id: user.id,  // guaranteed non-null now
    age: body.age || null,
    occupation: body.activity_level || null,
    pain_location: body.primary_concern || null,
    current_medications: body.medical_history ? [body.medical_history] : [],
    status: 'onboarding',
    current_risk_level: 'low'
  };

  const { data: patient, error: patientError } = await adminClient
    .from('patients')
    .upsert(patientPayload, { onConflict: 'user_id' })
    .select('*')
    .single();
  if (patientError) throw httpError(500, 'Unable to save patient profile', patientError);

  const { data: onboarding, error: onboardingError } = await adminClient
    .from('onboarding')
    .insert({
      patient_id: patient.id,
      current_step: 1,
      total_steps: 6,
      step_1_data: {
        first_name: body.first_name,
        last_name: body.last_name || null,
        email: body.email || null,
        phone: body.phone || null,
        age: body.age || null
      },
      step_2_data: {
        activity_level: body.activity_level || null,
        primary_concern: body.primary_concern || null
      },
      step_3_data: {
        medical_history: body.medical_history || null
      }
    })
    .select('*')
    .single();
  if (onboardingError) throw httpError(500, 'Unable to save onboarding', onboardingError);

  // Generate a magic link so the patient can log into the portal immediately
  let portalLink = null;
  if (body.email) {
    try {
      const { data: linkData } = await adminClient.auth.admin.generateLink({
        type: 'magiclink',
        email: body.email
      });
      portalLink = linkData?.properties?.action_link || null;
    } catch (_) {
      // Non-fatal — portal link is a convenience, not a blocker
    }
  }

  res.status(201).json({ user, patient, onboarding, portalLink });
}

async function createPublicAppointment(req, res) {
  const body = appointmentSchema.parse(req.body);
  const patient = await findPatientByContact(body) || await createMinimalPatientFromAppointment(body);

  const { data: doctor } = await adminClient.from('doctors').select('id').limit(1).maybeSingle();
  const doctorId = patient.assigned_doctor_id || doctor?.id || null;

  const notes = [
    body.note,
    body.program ? `Program: ${body.program}` : null,
    body.physiotherapist ? `Preferred physiotherapist: ${body.physiotherapist}` : null,
    body.patient_name ? `Booked by: ${body.patient_name}` : null,
    body.phone ? `Phone: ${body.phone}` : null
  ].filter(Boolean).join('\n');

  const { data: appointment, error } = await adminClient
    .from('appointments')
    .insert({
      patient_id: patient.id,
      doctor_id: doctorId,
      appointment_date: body.appointment_date || new Date().toISOString().slice(0, 10),
      appointment_time: body.appointment_time || 'To be confirmed',
      duration_minutes: 30,
      type: appointmentType(body.appointment_type || body.program),
      status: body.status === 'inquiry' ? 'pending' : 'scheduled',
      notes: notes || null
    })
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to create appointment', error);

  if (doctorId) {
    await adminClient.from('notifications').insert({
      patient_id: patient.id,
      doctor_id: doctorId,
      type: 'appointment',
      title: 'New appointment booking',
      message: `${body.patient_name || 'A patient'} requested ${appointment.appointment_date || 'a date'} at ${appointment.appointment_time || 'a time'}`,
      priority: 'normal'
    });
  }

  res.status(201).json({ appointment, patient });
}

module.exports = {
  savePublicProfile,
  createPublicAppointment
};