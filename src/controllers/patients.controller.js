const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { assertPatientAccess } = require('../services/access.service');

async function getPatient(req, res) {
  const patient = await assertPatientAccess(req.userProfile, req.params.id);
  res.json({ patient });
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
    .order('sent_at', { ascending: false });
  if (error) throw httpError(500, 'Unable to load notifications', error);
  res.json({ notifications: data });
}

module.exports = {
  getPatient,
  updatePatient,
  getTreatmentPlan,
  getAppointments,
  getNotifications
};
