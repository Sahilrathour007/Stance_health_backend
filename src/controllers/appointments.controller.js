const { z } = require('zod');
const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { assertPatientAccess, getDoctorForUser, getPatientForUser } = require('../services/access.service');

// ─── Schemas ────────────────────────────────────────────────────────────────

const VALID_STATUSES = ['pending', 'confirmed', 'rescheduled', 'completed', 'cancelled', 'no_show'];

const appointmentSchema = z.object({
  patient_id: z.string().uuid(),
  doctor_id: z.string().uuid().optional(),
  appointment_date: z.string(),
  appointment_time: z.string(),
  duration_minutes: z.number().int().positive().default(30),
  type: z.enum(['initial', 'follow_up', 'urgent', 'discharge']).default('follow_up'),
  notes: z.string().optional(),
  // Patients submit 'pending'. Internal booking can pass 'confirmed'.
  status: z.enum(['pending', 'confirmed']).default('pending')
});

const doctorUpdateSchema = z.object({
  status: z.enum(VALID_STATUSES).optional(),
  appointment_date: z.string().optional(),
  appointment_time: z.string().optional(),
  duration_minutes: z.number().int().positive().optional(),
  type: z.enum(['initial', 'follow_up', 'urgent', 'discharge']).optional(),
  notes: z.string().optional(),
  doctor_note: z.string().optional()  // doctor's message to patient on reschedule/cancel
});

const patientUpdateSchema = z.object({
  status: z.literal('cancelled'),  // patients can ONLY cancel
  notes: z.string().optional()
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isMissingColumnError(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === '42703' || (message.includes('column') && message.includes('does not exist'));
}

function dedupeAppointments(rows) {
  return Array.from(
    new Map((rows || []).filter(Boolean).map(row => [row.id, row])).values()
  ).sort((a, b) => {
    const aKey = `${a.appointment_date || ''} ${a.appointment_time || ''}`;
    const bKey = `${b.appointment_date || ''} ${b.appointment_time || ''}`;
    return aKey.localeCompare(bKey);
  });
}

async function loadPatientAppointments(patient, userProfile) {
  const appointmentRows = [];

  const { data: linkedRows, error: linkedError } = await adminClient
    .from('appointments')
    .select('*')
    .eq('patient_id', patient.id)
    .order('appointment_date', { ascending: true });
  if (linkedError) throw httpError(500, 'Unable to load appointments', linkedError);
  appointmentRows.push(...(linkedRows || []));

  const contactFilters = [
    ['patient_email', userProfile.email],
    ['email', userProfile.email],
    ['phone', userProfile.phone],
    ['patient_phone', userProfile.phone]
  ].filter(([, value]) => value);

  for (const [column, value] of contactFilters) {
    const { data, error } = await adminClient
      .from('appointments')
      .select('*')
      .eq(column, value)
      .order('appointment_date', { ascending: true });

    if (error) {
      if (isMissingColumnError(error)) continue;
      throw httpError(500, 'Unable to load appointments by contact', error);
    }
    appointmentRows.push(...(data || []));
  }

  return dedupeAppointments(appointmentRows);
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * POST /api/appointments
 * Patient requests an appointment — always inserted as 'pending'.
 * Doctor/admin can insert as 'confirmed' directly (e.g. walk-in booking).
 */
async function createAppointment(req, res) {
  const body = appointmentSchema.parse(req.body);
  const patient = await assertPatientAccess(req.userProfile, body.patient_id);
  const doctorId = body.doctor_id || patient.assigned_doctor_id || null;

  // Patients always get 'pending' regardless of what they send.
  // Only doctor/admin can create a pre-confirmed appointment.
  const insertStatus = req.userProfile.role === 'patient' ? 'pending' : (body.status || 'pending');

  // Slot conflict check: only for confirmed/pending slots, only when a doctor is assigned.
  if (doctorId) {
    const { data: existing, error: existingError } = await adminClient
      .from('appointments')
      .select('id')
      .eq('doctor_id', doctorId)
      .eq('appointment_date', body.appointment_date)
      .eq('appointment_time', body.appointment_time)
      .in('status', ['pending', 'confirmed', 'rescheduled']);
    if (existingError) throw httpError(500, 'Unable to check appointment availability', existingError);
    if (existing && existing.length) throw httpError(409, 'This slot already has a pending or confirmed appointment');
  }

  const { data, error } = await adminClient
    .from('appointments')
    .insert({
      patient_id: patient.id,
      doctor_id: doctorId,
      appointment_date: body.appointment_date,
      appointment_time: body.appointment_time,
      duration_minutes: body.duration_minutes || 30,
      type: body.type || 'follow_up',
      notes: body.notes || null,
      status: insertStatus
    })
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to create appointment', error);

  // Notify doctor of new pending request
  if (doctorId) {
    await adminClient.from('notifications').insert({
      patient_id: patient.id,
      doctor_id: doctorId,
      type: 'appointment_request',
      title: 'New appointment request',
      message: `${req.userProfile.name || 'A patient'} requested a ${body.type} appointment on ${body.appointment_date} at ${body.appointment_time}`,
      priority: body.type === 'urgent' ? 'urgent' : 'normal'
    });
  }

  res.status(201).json({ appointment: data });
}

/**
 * GET /api/appointments
 * - Patient: their own appointments (all statuses)
 * - Doctor:  their appointments, optionally filtered by status
 * - Admin:   unfiltered
 *
 * Query params: ?status=pending  (doctor/admin only)
 */
async function listAppointments(req, res) {
  const { status } = req.query;

  if (req.userProfile.role === 'patient') {
    const patient = await getPatientForUser(req.userProfile.id);
    if (!patient) throw httpError(404, 'Patient profile not found');
    const appointments = await loadPatientAppointments(patient, req.userProfile);
    return res.json({ appointments });
  }

  let query = adminClient
    .from('appointments')
    .select('*, patients(id, users(name, email, phone))')
    .order('appointment_date', { ascending: true });

  if (req.userProfile.role === 'doctor') {
    const doctor = await getDoctorForUser(req.userProfile.id);
    if (!doctor) throw httpError(404, 'Doctor profile not found');
    query = query.eq('doctor_id', doctor.id);
  }

  // Optional status filter — used by doctor dashboard pending queue
  if (status && VALID_STATUSES.includes(status)) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;
  if (error) throw httpError(500, 'Unable to load appointments', error);
  res.json({ appointments: data });
}

/**
 * GET /api/appointments/:id
 */
async function getAppointment(req, res) {
  const { data: appointment, error } = await adminClient
    .from('appointments')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) throw httpError(404, 'Appointment not found', error);
  await assertPatientAccess(req.userProfile, appointment.patient_id);
  res.json({ appointment });
}

/**
 * PUT /api/appointments/:id
 *
 * Patients can only CANCEL.
 * Doctors can confirm, reschedule, complete, cancel, no_show — plus change date/time and add doctor_note.
 *
 * On reschedule: doctor must supply new appointment_date + appointment_time.
 * Patient is notified automatically on every status change.
 */
async function updateAppointment(req, res) {
  const { data: appointment, error: loadError } = await adminClient
    .from('appointments')
    .select('*, patients(id, user_id, users(name, email))')
    .eq('id', req.params.id)
    .single();
  if (loadError) throw httpError(404, 'Appointment not found', loadError);

  await assertPatientAccess(req.userProfile, appointment.patient_id);

  let update = {};

  if (req.userProfile.role === 'patient') {
    // Strict: patient can ONLY cancel
    const body = patientUpdateSchema.parse(req.body);
    update = { status: 'cancelled', notes: body.notes || appointment.notes };
  } else {
    // Doctor or admin
    const body = doctorUpdateSchema.parse(req.body);

    // Reschedule guard: if rescheduling, new date+time are mandatory
    if (body.status === 'rescheduled') {
      if (!body.appointment_date || !body.appointment_time) {
        throw httpError(400, 'Rescheduling requires both appointment_date and appointment_time');
      }
    }

    for (const key of ['status', 'appointment_date', 'appointment_time', 'duration_minutes', 'type', 'notes', 'doctor_note']) {
      if (Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined) {
        update[key] = body[key];
      }
    }
  }

  const { data, error } = await adminClient
    .from('appointments')
    .update(update)
    .eq('id', req.params.id)
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to update appointment', error);

  // ── Auto-notify patient on status change ──────────────────────────────────
  const newStatus = update.status;
  const patientId = appointment.patient_id;
  const doctorId = appointment.doctor_id;

  if (newStatus && patientId) {
    const notificationMap = {
      confirmed: {
        title: 'Appointment confirmed',
        message: `Your appointment on ${data.appointment_date} at ${data.appointment_time} has been confirmed.`,
        priority: 'normal'
      },
      rescheduled: {
        title: 'Appointment rescheduled',
        message: `Your appointment has been moved to ${data.appointment_date} at ${data.appointment_time}.${data.doctor_note ? ` Note from your physiotherapist: ${data.doctor_note}` : ''}`,
        priority: 'normal'
      },
      cancelled: {
        title: 'Appointment cancelled',
        message: `Your appointment on ${appointment.appointment_date} has been cancelled.${data.doctor_note ? ` Reason: ${data.doctor_note}` : ''}`,
        priority: 'high'
      },
      completed: {
        title: 'Appointment completed',
        message: `Your session on ${data.appointment_date} has been marked complete. Check your treatment plan for any updates.`,
        priority: 'low'
      }
    };

    const notif = notificationMap[newStatus];
    if (notif) {
      await adminClient.from('notifications').insert({
        patient_id: patientId,
        doctor_id: doctorId || null,
        type: `appointment_${newStatus}`,
        title: notif.title,
        message: notif.message,
        priority: notif.priority
      });
    }
  }

  res.json({ appointment: data });
}

/**
 * DELETE /api/appointments/:id
 * Hard delete — only for admins or if appointment is still pending.
 */
async function deleteAppointment(req, res) {
  const { data: appointment, error: loadError } = await adminClient
    .from('appointments')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (loadError) throw httpError(404, 'Appointment not found', loadError);
  await assertPatientAccess(req.userProfile, appointment.patient_id);

  // Patients can only delete pending appointments. Everything else — use cancel.
  if (req.userProfile.role === 'patient' && appointment.status !== 'pending') {
    throw httpError(403, 'You can only delete pending appointments. Use cancel for confirmed appointments.');
  }

  const { error } = await adminClient
    .from('appointments')
    .delete()
    .eq('id', req.params.id);
  if (error) throw httpError(500, 'Unable to delete appointment', error);
  res.status(204).send();
}

module.exports = {
  createAppointment,
  listAppointments,
  getAppointment,
  updateAppointment,
  deleteAppointment
};