const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { getDoctorForUser } = require('../services/access.service');

async function getDashboard(req, res) {
  const isAdmin = req.userProfile.role === 'admin';
  const doctor = isAdmin ? null : await getDoctorForUser(req.userProfile.id);
  if (!isAdmin && !doctor) throw httpError(404, 'Doctor profile not found');

  const doctorId = doctor?.id;
  const dashboardQuery = adminClient.from('doctor_dashboard').select('*');
  const { data: dashboardRows, error: dashboardError } = await (doctorId
    ? dashboardQuery.eq('doctor_id', doctorId)
    : dashboardQuery);
  if (dashboardError) throw httpError(500, 'Unable to load dashboard aggregates', dashboardError);

  let patientsQuery = adminClient
    .from('patients')
    .select('*, users(name,email,phone)')
    .in('current_risk_level', ['critical', 'high', 'moderate'])
    .order('overall_risk_score', { ascending: false, nullsFirst: false })
    .limit(10);
  if (doctorId) patientsQuery = patientsQuery.eq('assigned_doctor_id', doctorId);
  const { data: topRiskPatients, error: patientsError } = await patientsQuery;
  if (patientsError) throw httpError(500, 'Unable to load risk patients', patientsError);

  const today = new Date().toISOString().slice(0, 10);
  let appointmentsQuery = adminClient
    .from('appointments')
    .select('*, patients(id, users(name,email,phone))')
    .eq('appointment_date', today)
    .order('appointment_time', { ascending: true });
  if (doctorId) appointmentsQuery = appointmentsQuery.eq('doctor_id', doctorId);
  const { data: todaysAppointments, error: apptError } = await appointmentsQuery;
  if (apptError) throw httpError(500, 'Unable to load appointments', apptError);

  let notificationQuery = adminClient
    .from('notifications')
    .select('*')
    .eq('is_read', false)
    .order('sent_at', { ascending: false })
    .limit(20);
  if (doctorId) notificationQuery = notificationQuery.eq('doctor_id', doctorId);
  const { data: unreadNotifications, error: notificationError } = await notificationQuery;
  if (notificationError) throw httpError(500, 'Unable to load notifications', notificationError);

  const patientIds = topRiskPatients.map((patient) => patient.id);
  let recentCheckIns = [];
  if (patientIds.length) {
    const { data, error } = await adminClient
      .from('check_ins')
      .select('*')
      .in('patient_id', patientIds)
      .order('submitted_at', { ascending: false })
      .limit(20);
    if (error) throw httpError(500, 'Unable to load recent check-ins', error);
    recentCheckIns = data;
  }

  res.json({
    doctor,
    counts: dashboardRows[0] || null,
    urgentPatients: topRiskPatients,
    todaysAppointments,
    unreadNotifications,
    recentCheckIns
  });
}

module.exports = {
  getDashboard
};
