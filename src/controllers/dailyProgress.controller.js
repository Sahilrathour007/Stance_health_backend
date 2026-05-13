const { z } = require('zod');
const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { getPatientForUser } = require('../services/access.service');

// ─── Validation schema ────────────────────────────────────────────────────────

const dailyProgressSchema = z.object({
  exercises_completed: z.number().int().min(0),
  exercises_total:     z.number().int().min(1),
  pain_level:          z.number().min(0).max(10).nullable().optional(),
  confidence:          z.number().min(0).max(10).nullable().optional(),
  // date is optional — defaults to today server-side.
  // Never trust client-supplied date blindly for security, but accept it
  // for cases where patient submits slightly past midnight.
  date:                z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

// ─── ISO week number (Monday-based, 1–53) ────────────────────────────────────
function getISOWeekNumber(dateStr) {
  const date = new Date(dateStr + 'T00:00:00Z');
  const dayOfWeek = date.getUTCDay() || 7; // Mon=1 … Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86_400_000 + 1) / 7);
}

// ─── POST /api/patients/me/daily-progress ────────────────────────────────────
/**
 * Called by the patient portal after the patient marks exercises done
 * (and optionally submits pain level + confidence via the check-in modal).
 *
 * Flow:
 *   1. Validate body with Zod
 *   2. Look up patient record from auth user
 *   3. Upsert into daily_patient_progress (one row per patient per day)
 *   4. DB trigger (trg_sync_patient_metrics) auto-aggregates into patient_metrics
 *   5. Return the saved daily row + the freshly recalculated weekly metrics
 *
 * Why we return patientMetrics:
 *   The frontend needs fresh weekly aggregates immediately after saving so the
 *   progress chart and signals update in real time — without a full page reload.
 */
async function submitDailyProgress(req, res) {
  // Auth guard — only patients can submit their own daily progress
  if (req.userProfile.role !== 'patient') {
    throw httpError(403, 'Only patients can submit daily progress');
  }

  // Resolve patient record
  const patient = await getPatientForUser(req.userProfile.id);
  if (!patient) throw httpError(404, 'Patient profile not found');

  // Validate body
  let body;
  try {
    body = dailyProgressSchema.parse(req.body);
  } catch (err) {
    throw httpError(400, 'Invalid progress data', err);
  }

  // Clamp date to today ± 1 day — don't let patients back-date freely
  const serverToday = new Date().toISOString().slice(0, 10);
  const yesterday   = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const submittedDate = body.date || serverToday;
  if (submittedDate !== serverToday && submittedDate !== yesterday) {
    throw httpError(400, `Progress can only be submitted for today or yesterday. Received: ${submittedDate}`);
  }

  const weekNumber = getISOWeekNumber(submittedDate);

  // Completion rate — never hardcode 100. Calculate from actual counts.
  const completionRate = body.exercises_total > 0
    ? Math.round((body.exercises_completed / body.exercises_total) * 100)
    : 0;

  const payload = {
    patient_id:          patient.id,
    date:                submittedDate,
    week_number:         weekNumber,
    exercises_completed: body.exercises_completed,
    exercises_total:     body.exercises_total,
    pain_level:          body.pain_level   ?? null,
    confidence:          body.confidence   ?? null,
    submitted_at:        new Date().toISOString()
  };

  // Upsert on (patient_id, date) — one row per day.
  // If patient taps "skip" first then comes back to add pain/confidence,
  // the update overwrites the earlier row for the same day correctly.
  const { data: dailyRow, error: dailyError } = await adminClient
    .from('daily_patient_progress')
    .upsert(payload, { onConflict: 'patient_id,date' })
    .select('*')
    .single();

  if (dailyError) {
    throw httpError(500, 'Unable to save daily progress', dailyError);
  }

  // The DB trigger trg_sync_patient_metrics has now run and updated patient_metrics.
  // Fetch fresh weekly aggregates to return to the frontend immediately.
  const { data: patientMetrics, error: metricsError } = await adminClient
    .from('patient_metrics')
    .select('*')
    .eq('patient_id', patient.id)
    .order('week_number', { ascending: false })
    .limit(12);

  if (metricsError) {
    // Non-fatal — daily row was saved successfully. Warn and return what we have.
    console.warn('patient_metrics refetch after upsert failed:', metricsError.message);
  }

  res.status(201).json({
    dailyProgress:  dailyRow,
    patientMetrics: patientMetrics || [],
    weekNumber,
    completionRate,
    message: body.pain_level !== null && body.pain_level !== undefined
      ? 'Progress, pain level, and confidence saved.'
      : 'Exercise progress saved. Add pain and confidence next session for full tracking.'
  });
}

// ─── GET /api/patients/me/daily-progress ─────────────────────────────────────
/**
 * Returns the last 30 days of daily_patient_progress for the logged-in patient.
 * Used by the Reports page to show day-by-day history.
 */
async function getMyDailyProgress(req, res) {
  if (req.userProfile.role !== 'patient') {
    throw httpError(403, 'Only patients can view their daily progress');
  }

  const patient = await getPatientForUser(req.userProfile.id);
  if (!patient) throw httpError(404, 'Patient profile not found');

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  const { data, error } = await adminClient
    .from('daily_patient_progress')
    .select('*')
    .eq('patient_id', patient.id)
    .gte('date', thirtyDaysAgo)
    .order('date', { ascending: false });

  if (error) throw httpError(500, 'Unable to load daily progress', error);

  res.json({ dailyProgress: data || [] });
}

module.exports = { submitDailyProgress, getMyDailyProgress };
