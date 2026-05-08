const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { assertPatientAccess, getDoctorForUser, getPatientForUser } = require('../services/access.service');

async function listPatients(req, res) {
  const isAdmin = req.userProfile.role === 'admin';
  const doctor = isAdmin ? null : await getDoctorForUser(req.userProfile.id);
  if (!isAdmin && !doctor) throw httpError(404, 'Doctor profile not found');

  let query = adminClient
    .from('patients')
    .select('*, users(name,email,phone)')
    .order('created_at', { ascending: false });

  if (doctor?.id) query = query.eq('assigned_doctor_id', doctor.id);

  const { data, error } = await query;
  if (error) throw httpError(500, 'Unable to load patients', error);
  res.json({ patients: data || [] });
}

async function getPatient(req, res) {
  const patient = await assertPatientAccess(req.userProfile, req.params.id);
  res.json({ patient });
}

async function getMyPatient(req, res) {
  if (req.userProfile.role !== 'patient') throw httpError(403, 'Only patients can use this endpoint');
  const patient = await getPatientForUser(req.userProfile.id);
  if (!patient) throw httpError(404, 'Patient profile not found');

  const [
    { data: treatmentPlan, error: planError },
    { data: appointments, error: appointmentError },
    { data: checkIns, error: checkInError },
    { data: doctor, error: doctorError }
  ] = await Promise.all([
    adminClient.from('treatment_plans').select('*').eq('patient_id', patient.id).maybeSingle(),
    adminClient.from('appointments').select('*').eq('patient_id', patient.id).order('appointment_date', { ascending: true }),
    adminClient.from('check_ins').select('*').eq('patient_id', patient.id).order('submitted_at', { ascending: false }).limit(20),
    patient.assigned_doctor_id
      ? adminClient.from('doctors').select('id, specialty, users(name,email,phone)').eq('id', patient.assigned_doctor_id).maybeSingle()
      : Promise.resolve({ data: null, error: null })
  ]);

  if (planError) throw httpError(500, 'Unable to load treatment plan', planError);
  if (appointmentError) throw httpError(500, 'Unable to load appointments', appointmentError);
  if (checkInError) throw httpError(500, 'Unable to load check-ins', checkInError);
  if (doctorError) throw httpError(500, 'Unable to load assigned doctor', doctorError);

  res.json({
    user: req.userProfile,
    patient,
    doctor: doctor ? {
      id: doctor.id,
      name: doctor.users?.name || null,
      email: doctor.users?.email || null,
      phone: doctor.users?.phone || null,
      specialty: doctor.specialty || null
    } : null,
    treatmentPlan: treatmentPlan || null,
    appointments: appointments || [],
    upcomingAppointments: (appointments || []).filter(a => a.appointment_date >= new Date().toISOString().slice(0, 10)),
    pastAppointments: (appointments || []).filter(a => a.appointment_date < new Date().toISOString().slice(0, 10)),
    checkIns: checkIns || []
  });
}

async function updatePatient(req, res) {
  const patient = await assertPatientAccess(req.userProfile, req.params.id);
  const allowed = [
    'age',
    'gender',
    'occupation',
    'pain_location',
    'pain_severity',
    'onset_type',
    'pain_duration',
    'current_medications',
    'past_surgeries',
    'comorbidities',
    'treatment_goals',
    'cohort'
  ];
  const update = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) update[key] = req.body[key];
  }
  if (!Object.keys(update).length) throw httpError(400, 'No supported patient fields provided');

  const { data, error } = await adminClient
    .from('patients')
    .update(update)
    .eq('id', patient.id)
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to update patient', error);
  res.json({ patient: data });
}

async function getTreatmentPlan(req, res) {
  const patient = await assertPatientAccess(req.userProfile, req.params.id);
  const { data, error } = await adminClient
    .from('treatment_plans')
    .select('*')
    .eq('patient_id', patient.id)
    .maybeSingle();
  if (error) throw httpError(500, 'Unable to load treatment plan', error);
  res.json({ treatmentPlan: data });
}

async function getAppointments(req, res) {
  const patient = await assertPatientAccess(req.userProfile, req.params.id);
  const { data, error } = await adminClient
    .from('appointments')
    .select('*')
    .eq('patient_id', patient.id)
    .order('appointment_date', { ascending: true });
  if (error) throw httpError(500, 'Unable to load appointments', error);
  res.json({ appointments: data });
}

async function getNotifications(req, res) {
  const patient = await assertPatientAccess(req.userProfile, req.params.id);
  const { data, error } = await adminClient
    .from('notifications')
    .select('*')
    .eq('patient_id', patient.id)
    .order('created_at', { ascending: false });
  if (error) throw httpError(500, 'Unable to load notifications', error);
  res.json({ notifications: data });
}

module.exports = {
  listPatients,
  getMyPatient,
  getPatient,
  updatePatient,
  getTreatmentPlan,
  getAppointments,
  getNotifications
};
