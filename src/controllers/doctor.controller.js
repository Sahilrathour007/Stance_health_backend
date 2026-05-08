const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { getDoctorForUser } = require('../services/access.service');

/**
 * GET /api/doctor/dashboard
 *
 * Returns a triage-first view, not just a patient list.
 * Sections:
 *   1. pendingAppointments   — awaiting doctor action (approve/reschedule/cancel)
 *   2. urgentPatients        — high/critical risk, ordered by risk score
 *   3. draftPlans            — plans created but not yet activated
 *   4. todaysAppointments    — confirmed appointments for today
 *   5. unreadNotifications   — unread alerts
 *   6. recentCheckIns        — latest check-ins from high-risk patients
 *   7. counts                — aggregate stats from doctor_dashboard view
 *   8. reactivationCandidates — patients discharged or inactive > 30 days
 */
async function getDashboard(req, res) {
  const isAdmin = req.userProfile.role === 'admin';
  const doctor = isAdmin ? null : await getDoctorForUser(req.userProfile.id);
  if (!isAdmin && !doctor) throw httpError(404, 'Doctor profile not found');

  const doctorId = doctor?.id || null;

  // ── 1. Pending Appointments (need doctor decision) ────────────────────────
  let pendingQuery = adminClient
    .from('appointments')
    .select('*, patients(id, pain_location, current_risk_level, users(name, email, phone))')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });   // FIFO — oldest first
  if (doctorId) pendingQuery = pendingQuery.eq('doctor_id', doctorId);
  const { data: pendingAppointments, error: pendingError } = await pendingQuery;
  if (pendingError) throw httpError(500, 'Unable to load pending appointments', pendingError);

  // ── 2. High/Critical Risk Patients (triage) ───────────────────────────────
  let riskQuery = adminClient
    .from('patients')
    .select('*, users(name, email, phone)')
    .in('current_risk_level', ['critical', 'high', 'moderate'])
    .order('overall_risk_score', { ascending: false, nullsFirst: false })
    .limit(10);
  if (doctorId) riskQuery = riskQuery.eq('assigned_doctor_id', doctorId);
  const { data: urgentPatients, error: riskError } = await riskQuery;
  if (riskError) throw httpError(500, 'Unable to load risk patients', riskError);

  // ── 3. Draft Plans Awaiting Activation ───────────────────────────────────
  let draftQuery = adminClient
    .from('treatment_plans')
    .select('*, patients(id, users(name, email, phone))')
    .eq('status', 'draft')
    .order('created_at', { ascending: true });
  if (doctorId) draftQuery = draftQuery.eq('doctor_id', doctorId);
  const { data: draftPlans, error: draftError } = await draftQuery;
  if (draftError) throw httpError(500, 'Unable to load draft plans', draftError);

  // ── 4. Today's Confirmed Appointments ────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  let apptQuery = adminClient
    .from('appointments')
    .select('*, patients(id, users(name, email, phone))')
    .eq('appointment_date', today)
    .in('status', ['confirmed', 'rescheduled'])
    .order('appointment_time', { ascending: true });
  if (doctorId) apptQuery = apptQuery.eq('doctor_id', doctorId);
  const { data: todaysAppointments, error: apptError } = await apptQuery;
  if (apptError) throw httpError(500, 'Unable to load appointments', apptError);

  // ── 5. Unread Notifications ───────────────────────────────────────────────
  let notifQuery = adminClient
    .from('notifications')
    .select('*')
    .eq('is_read', false)
    .order('sent_at', { ascending: false })
    .limit(20);
  if (doctorId) notifQuery = notifQuery.eq('doctor_id', doctorId);
  const { data: unreadNotifications, error: notifError } = await notifQuery;
  if (notifError) throw httpError(500, 'Unable to load notifications', notifError);

  // ── 6. Recent Check-ins from High-Risk Patients ───────────────────────────
  const riskPatientIds = (urgentPatients || []).map(p => p.id);
  let recentCheckIns = [];
  if (riskPatientIds.length) {
    const { data, error } = await adminClient
      .from('check_ins')
      .select('*, patients(id, users(name))')
      .in('patient_id', riskPatientIds)
      .order('submitted_at', { ascending: false })
      .limit(20);
    if (error) throw httpError(500, 'Unable to load recent check-ins', error);
    recentCheckIns = data;
  }

  // ── 7. Dashboard Aggregate Counts ─────────────────────────────────────────
  const dashQuery = adminClient.from('doctor_dashboard').select('*');
  const { data: dashboardRows, error: dashError } = doctorId
    ? await dashQuery.eq('doctor_id', doctorId)
    : await dashQuery;
  if (dashError) throw httpError(500, 'Unable to load dashboard aggregates', dashError);

  // ── 8. Reactivation Candidates ────────────────────────────────────────────
  // Patients who were discharged or last seen > 30 days ago — retention opportunity
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let reactivationQuery = adminClient
    .from('patients')
    .select('*, users(name, email, phone)')
    .in('status', ['discharged', 'inactive'])
    .lt('updated_at', thirtyDaysAgo)
    .order('updated_at', { ascending: true })
    .limit(10);
  if (doctorId) reactivationQuery = reactivationQuery.eq('assigned_doctor_id', doctorId);
  const { data: reactivationCandidates, error: reactivationError } = await reactivationQuery;
  if (reactivationError) throw httpError(500, 'Unable to load reactivation candidates', reactivationError);

  res.json({
    doctor,
    // Triage sections — ordered by urgency
    pendingAppointments: pendingAppointments || [],
    urgentPatients: urgentPatients || [],
    draftPlans: draftPlans || [],
    todaysAppointments: todaysAppointments || [],
    recentCheckIns,
    reactivationCandidates: reactivationCandidates || [],
    unreadNotifications: unreadNotifications || [],
    counts: dashboardRows?.[0] || null,
    // Summary numbers for the top-bar badges
    badges: {
      pendingAppointments: (pendingAppointments || []).length,
      draftPlans: (draftPlans || []).length,
      unreadNotifications: (unreadNotifications || []).length,
      urgentPatients: (urgentPatients || []).filter(p => p.current_risk_level === 'critical').length
    }
  });
}

/**
 * GET /api/doctor/patients
 * Full patient list for the doctor, with basic risk info.
 * Separate from the dashboard — the dashboard is triage, this is management.
 */
async function listDoctorPatients(req, res) {
  const isAdmin = req.userProfile.role === 'admin';
  const doctor = isAdmin ? null : await getDoctorForUser(req.userProfile.id);
  if (!isAdmin && !doctor) throw httpError(404, 'Doctor profile not found');

  let query = adminClient
    .from('patients')
    .select('*, users(name, email, phone)')
    .order('current_risk_level', { ascending: false })
    .order('created_at', { ascending: false });

  if (doctor?.id) query = query.eq('assigned_doctor_id', doctor.id);

  const { data, error } = await query;
  if (error) throw httpError(500, 'Unable to load patients', error);
  res.json({ patients: data || [] });
}

module.exports = {
  getDashboard,
  listDoctorPatients
};