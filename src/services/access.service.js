const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');

async function getDoctorForUser(userId) {
  const { data, error } = await adminClient
    .from('doctors')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw httpError(500, 'Unable to load doctor profile', error);
  return data;
}

async function getPatientForUser(userId) {
  const { data, error } = await adminClient
    .from('patients')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw httpError(500, 'Unable to load patient profile', error);
  return data;
}

async function assertPatientAccess(userProfile, patientId) {
  const { data: patient, error } = await adminClient
    .from('patients')
    .select('*')
    .eq('id', patientId)
    .maybeSingle();

  if (error) throw httpError(500, 'Unable to load patient', error);
  if (!patient) throw httpError(404, 'Patient not found');

  if (userProfile.role === 'admin') return patient;
  if (userProfile.role === 'patient' && patient.user_id === userProfile.id) return patient;
  if (userProfile.role === 'doctor') {
    const doctor = await getDoctorForUser(userProfile.id);
    if (doctor && patient.assigned_doctor_id === doctor.id) return patient;
  }

  throw httpError(403, 'You do not have access to this patient');
}

module.exports = {
  assertPatientAccess,
  getDoctorForUser,
  getPatientForUser
};
