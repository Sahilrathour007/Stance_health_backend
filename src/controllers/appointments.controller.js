const { z } = require('zod');
const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { assertPatientAccess, getDoctorForUser, getPatientForUser } = require('../services/access.service');

const appointmentSchema = z.object({
  patient_id: z.string().uuid(),
  doctor_id: z.string().uuid().optional(),
  appointment_date: z.string(),
  appointment_time: z.string(),
  duration_minutes: z.number().int().positive().default(30),
  type: z.enum(['initial', 'follow_up', 'urgent', 'discharge']).default('follow_up'),
  notes: z.string().optional()
});

async function createAppointment(req, res) {
  const body = appointmentSchema.parse(req.body);
  const patient = await assertPatientAccess(req.userProfile, body.patient_id);
  const doctorId = body.doctor_id || patient.assigned_doctor_id || null;

  // Only check for slot conflicts when a specific doctor is involved — a null doctor_id
  // would match ALL rows where doctor_id IS NULL, producing false conflicts.
  if (doctorId) {
    const { data: existing, error: existingError } = await adminClient
      .from('appointments')
      .select('id')
      .eq('doctor_id', doctorId)
      .eq('appointment_date', body.appointment_date)
      .eq('appointment_time', body.appointment_time)
      .in('status', ['scheduled', 'confirmed', 'pending']);
    if (existingError) throw httpError(500, 'Unable to check appointment availability', existingError);
    if (existing && existing.length) throw httpError(409, 'This slot is already booked');
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
      status: 'scheduled'
    })
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to create appointment', error);

  // Only fire notification when a doctor is assigned
  if (doctorId) {
    await adminClient.from('notifications').insert({
      patient_id: patient.id,
      doctor_id: doctorId,
      type: 'appointment',
      title: 'New appointment request',
      message: `${body.type} appointment requested for ${body.appointment_date} at ${body.appointment_time}`,
      priority: body.type === 'urgent' ? 'urgent' : 'normal'
    });
  }

  res.status(201).json({ appointment: data });
}

async function listAppointments(req, res) {
  let query = adminClient.from('appointments').select('*').order('appointment_date', { ascending: true });

  if (req.userProfile.role === 'patient') {
    const patient = await getPatientForUser(req.userProfile.id);
    if (!patient) throw httpError(404, 'Patient profile not found');
    query = query.eq('patient_id', patient.id);
  } else if (req.userProfile.role === 'doctor') {
    const doctor = await getDoctorForUser(req.userProfile.id);
    if (!doctor) throw httpError(404, 'Doctor profile not found');
    query = query.eq('doctor_id', doctor.id);
  }
  // admin role gets unfiltered list intentionally
  const { data, error } = await query;
  if (error) throw httpError(500, 'Unable to load appointments', error);
  res.json({ appointments: data });
}

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

async function updateAppointment(req, res) {
  const { data: appointment, error: loadError } = await adminClient
    .from('appointments')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (loadError) throw httpError(404, 'Appointment not found', loadError);
  await assertPatientAccess(req.userProfile, appointment.patient_id);

  const allowed = req.userProfile.role === 'patient'
    ? ['notes', 'status']
    : ['appointment_date', 'appointment_time', 'duration_minutes', 'type', 'status', 'notes', 'doctor_notes'];
  const update = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) update[key] = req.body[key];
  }
  if (req.userProfile.role === 'patient' && update.status && update.status !== 'cancelled') {
    throw httpError(403, 'Patients can only cancel their own appointments');
  }

  const { data, error } = await adminClient
    .from('appointments')
    .update(update)
    .eq('id', req.params.id)
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to update appointment', error);
  res.json({ appointment: data });
}

async function deleteAppointment(req, res) {
  const { data: appointment, error: loadError } = await adminClient
    .from('appointments')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (loadError) throw httpError(404, 'Appointment not found', loadError);
  await assertPatientAccess(req.userProfile, appointment.patient_id);

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