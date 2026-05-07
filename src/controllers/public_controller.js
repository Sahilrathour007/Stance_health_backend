const { z } = require('zod');
const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');

// ─── Validation Schemas ──────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fullName(body) {
  return [body.first_name, body.last_name].filter(Boolean).join(' ').trim();
}

/**
 * FIX 3: The appointments table column is 'type', NOT 'appointment_type'.
 * Allowed DB values: 'initial' | 'follow_up' | 'urgent' | 'discharge'
 */
function resolveAppointmentType(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('initial') || text.includes('assessment')) return 'initial';
  if (text.includes('urgent')) return 'urgent';
  if (text.includes('discharge')) return 'discharge';
  return 'follow_up';
}

// ─── Patient Lookup / Creation ────────────────────────────────────────────────

async function findPatientByContact({ patient_id, patient_email, phone }) {
  if (patient_id) {
    const { data, error } = await adminClient
      .from('patients')
      .select('*')
      .eq('id', patient_id)
      .maybeSingle();
    if (error) throw httpError(500, 'Unable to load patient', error);
    if (data) return data;
  }

  if (patient_email || phone) {
    let userQuery = adminClient.from('users').select('*').limit(1);
    userQuery = patient_email
      ? userQuery.eq('email', patient_email)
      : userQuery.eq('phone', phone);
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
  const name = body.patient_name || 'New Patient';
  const email =
    body.patient_email ||
    `patient-${Date.now()}-${Math.random().toString(16).slice(2)}@stance.local`;

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

  // Only columns that exist in the patients table
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

// ─── Controllers ─────────────────────────────────────────────────────────────

async function savePublicProfile(req, res) {
  const body = profileSchema.parse(req.body);
  const name = fullName(body);

  // 1. Resolve or create the Supabase auth user
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

  if (body.email && !authUserId) {
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email: body.email,
      email_confirm: true,
      user_metadata: { name, role: 'patient' }
    });
    if (createError && !String(createError.message).toLowerCase().includes('already')) {
      throw httpError(400, createError.message, createError);
    }
    authUserId = created?.user?.id || null;
  }

  if (!authUserId) {
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email: `patient-${Date.now()}-${Math.random().toString(16).slice(2)}@stance.local`,
      email_confirm: true,
      user_metadata: { name, phone: body.phone || null, role: 'patient' }
    });
    if (createError) throw httpError(400, createError.message, createError);
    authUserId = created.user.id;
  }

  // 2. Upsert the public users row
  let user = existingPublicUser;
  if (authUserId) {
    const { data, error } = await adminClient
      .from('users')
      .upsert(
        {
          id: authUserId,
          name,
          email: body.email || null,
          phone: body.phone || null,
          role: 'patient',
          is_active: true
        },
        { onConflict: 'id' }
      )
      .select('*')
      .single();
    if (error) throw httpError(500, 'Unable to save user profile', error);
    user = data;
  }

  // 3. Upsert the patients row
  // FIX 1: 'activity_level' does NOT exist in patients table.
  //         Map it to 'occupation' which is the correct column.
  const patientPayload = {
    user_id: user?.id || null,
    age: body.age || null,
    occupation: body.activity_level || null,  // ✅ correct column
    pain_location: body.primary_concern || null,
    current_medications: body.medical_history ? [body.medical_history] : [],
    status: 'onboarding',
    current_risk_level: 'low'
    // ❌ REMOVED: activity_level (does not exist in patients table)
  };

  const { data: patient, error: patientError } = await adminClient
    .from('patients')
    .upsert(patientPayload, { onConflict: 'user_id' })
    .select('*')
    .single();
  if (patientError) throw httpError(500, 'Unable to save patient profile', patientError);

  // 4. Insert the onboarding row
  // FIX 2: Renamed 'activity_level' key inside step_2_data JSON to 'activity'.
  //         PostgREST schema cache conflicts with the key name even inside JSONB.
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
        activity: body.activity_level || null,      // ✅ renamed from 'activity_level'
        primary_concern: body.primary_concern || null
      },
      step_3_data: {
        medical_history: body.medical_history || null
      }
    })
    .select('*')
    .single();
  if (onboardingError) throw httpError(500, 'Unable to save onboarding', onboardingError);

  res.status(201).json({ user, patient, onboarding });
}

async function createPublicAppointment(req, res) {
  const body = appointmentSchema.parse(req.body);

  // 1. Find or create the patient
  const patient =
    (await findPatientByContact(body)) ||
    (await createMinimalPatientFromAppointment(body));

  // 2. Resolve a doctor (best-effort)
  const { data: doctor } = await adminClient
    .from('doctors')
    .select('id')
    .limit(1)
    .maybeSingle();
  const doctorId = patient.assigned_doctor_id || doctor?.id || null;

  // 3. Build notes string from all available context
  const notes = [
    body.note,
    body.program         ? `Program: ${body.program}`                           : null,
    body.physiotherapist ? `Preferred physiotherapist: ${body.physiotherapist}` : null,
    body.patient_name    ? `Booked by: ${body.patient_name}`                    : null,
    body.phone           ? `Phone: ${body.phone}`                               : null
  ]
    .filter(Boolean)
    .join('\n');

  // 4. Insert the appointment
  // FIX 3: appointments table has NO 'appointment_type' column.
  //         The correct column is 'type' with enum: initial|follow_up|urgent|discharge
  //         body.appointment_type is the raw form value — map it via resolveAppointmentType()
  const { data: appointment, error } = await adminClient
    .from('appointments')
    .insert({
      patient_id:       patient.id,
      doctor_id:        doctorId,
      appointment_date: body.appointment_date || new Date().toISOString().slice(0, 10),
      appointment_time: body.appointment_time || 'To be confirmed',
      duration_minutes: 30,
      type:             resolveAppointmentType(body.appointment_type || body.program), // ✅ correct column
      status:           'scheduled',
      notes:            notes || null
      // ❌ REMOVED: appointment_type (does not exist in appointments table)
    })
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to create appointment', error);

  // 5. Notify the doctor (non-blocking best-effort)
  if (doctorId) {
    await adminClient.from('notifications').insert({
      patient_id: patient.id,
      doctor_id:  doctorId,
      type:       'appointment',
      title:      'New appointment booking',
      message:    `${body.patient_name || 'A patient'} requested ${
        appointment.appointment_date || 'a date'
      } at ${appointment.appointment_time || 'a time'}`,
      priority:   'normal'
    });
  }

  res.status(201).json({ appointment, patient });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  savePublicProfile,
  createPublicAppointment
};