const { z } = require('zod');
const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { assertPatientAccess, getPatientForUser } = require('../services/access.service');

// ─── Schemas ─────────────────────────────────────────────────────────────────

const stepSchema = z.object({
  data: z.record(z.any())
});

// ─── Cohort Detection ─────────────────────────────────────────────────────────
// Matches the frontend's detectPrimaryCohort() logic so both sides agree.
// primary: corporate | gym | athlete | rehab
// These map to the behavioral profiles in the product spec.

const CORPORATE_SIGNALS = ['desk', 'office', 'sedentary', 'corporate', 'sitting', 'wfh', 'computer', 'posture'];
const GYM_SIGNALS       = ['gym', 'fitness', 'workout', 'lifting', 'crossfit', 'weight', 'training'];
const ATHLETE_SIGNALS   = ['sport', 'athlete', 'run', 'swim', 'cycle', 'football', 'cricket', 'tennis', 'basketball', 'competitive'];
const REHAB_SIGNALS     = ['surgery', 'fracture', 'chronic', 'pain', 'injury', 'rehab', 'recovery', 'post-op', 'anxiety', 'nerve'];

function matchesSignals(text, signals) {
  const lower = String(text || '').toLowerCase();
  return signals.some(s => lower.includes(s));
}

function detectCohorts(step1 = {}, step2 = {}) {
  const combined = [
    step1.occupation, step1.activity_level, step1.activity,
    step2.pain_location, step2.painLocation, step2.primary_concern, step2.cohort
  ].join(' ');

  const scores = {
    rehab:     matchesSignals(combined, REHAB_SIGNALS)     ? 2 : 0,
    athlete:   matchesSignals(combined, ATHLETE_SIGNALS)   ? 2 : 0,
    gym:       matchesSignals(combined, GYM_SIGNALS)       ? 2 : 0,
    corporate: matchesSignals(combined, CORPORATE_SIGNALS) ? 2 : 0
  };

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const primary   = sorted[0][1] > 0 ? sorted[0][0] : 'rehab';   // default to rehab if no signals
  const secondary = sorted[1][1] > 0 ? sorted[1][0] : null;
  const blendScore = sorted[0][1] > 0 && sorted[1][1] > 0
    ? Math.round((sorted[1][1] / (sorted[0][1] + sorted[1][1])) * 100)
    : 0;

  return { primary, secondary, blendScore };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractPatientUpdate(onboarding) {
  const step1 = onboarding.step_1_data || {};
  const step2 = onboarding.step_2_data || {};
  const step3 = onboarding.step_3_data || {};
  const step5 = onboarding.step_5_data || {};

  const toArray = (value) => {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    return null;
  };

  const oneOf = (value, allowed) => allowed.includes(value) ? value : null;

  // Detect cohorts from available step data
  const { primary, secondary, blendScore } = detectCohorts(step1, step2);

  return {
    age: step1.age ?? null,
    gender: oneOf(step1.gender, ['male', 'female', 'other']),
    occupation: step1.occupation ?? step1.activity_level ?? null,
    pain_location: step2.pain_location ?? step2.painLocation ?? null,
    pain_severity: step2.pain_severity ?? step2.painSeverity ?? null,
    onset_type: oneOf(step2.onset_type ?? step2.onsetType, ['sudden', 'gradual']),
    pain_duration: step2.pain_duration ?? step2.painDuration ?? null,
    current_medications: toArray(step3.current_medications ?? step3.medications),
    past_surgeries: toArray(step3.past_surgeries ?? step3.surgeries),
    comorbidities: toArray(step3.comorbidities),
    treatment_goals: toArray(step5.treatment_goals ?? step5.goals),
    // Cohort now uses the detected values — not a hardcoded enum mismatch
    primary_cohort: primary,
    secondary_cohort: secondary,
    blend_score: blendScore,
    // Keep the legacy cohort column if it exists, mapped from primary
    cohort: primary,
    status: 'active',
    onboarded_at: new Date().toISOString()
  };
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * POST /api/onboarding/start
 * Creates or resumes an onboarding session. Does NOT create a treatment plan.
 * The plan is created separately on completion — it belongs to the activation layer.
 */
async function startOnboarding(req, res) {
  let patient = await getPatientForUser(req.userProfile.id);
  if (!patient) {
    const { data, error } = await adminClient
      .from('patients')
      .insert({ user_id: req.userProfile.id, status: 'onboarding', current_risk_level: 'low' })
      .select('*')
      .single();
    if (error) throw httpError(500, 'Unable to create patient profile', error);
    patient = data;
  }

  const { data: existing, error: existingError } = await adminClient
    .from('onboarding')
    .select('*')
    .eq('patient_id', patient.id)
    .eq('is_complete', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) throw httpError(500, 'Unable to check existing onboarding', existingError);
  if (existing) return res.json({ patient, onboarding: existing });

  const { data: onboarding, error } = await adminClient
    .from('onboarding')
    .insert({ patient_id: patient.id, current_step: 1, total_steps: 6 })
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to start onboarding', error);

  res.status(201).json({ patient, onboarding });
}

/**
 * PUT /api/onboarding/:patientId/step/:stepNumber
 */
async function updateStep(req, res) {
  const stepNumber = Number(req.params.stepNumber);
  if (!Number.isInteger(stepNumber) || stepNumber < 1 || stepNumber > 6) {
    throw httpError(400, 'stepNumber must be between 1 and 6');
  }

  const patient = await assertPatientAccess(req.userProfile, req.params.patientId);
  const body = stepSchema.parse(req.body);
  const update = {
    [`step_${stepNumber}_data`]: body.data,
    current_step: Math.min(stepNumber + 1, 6)
  };

  const { data: existing, error: existingError } = await adminClient
    .from('onboarding')
    .select('id')
    .eq('patient_id', patient.id)
    .eq('is_complete', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) throw httpError(500, 'Unable to load onboarding', existingError);

  const query = existing
    ? adminClient.from('onboarding').update(update).eq('id', existing.id)
    : adminClient.from('onboarding').insert({ patient_id: patient.id, total_steps: 6, ...update });

  const { data, error } = await query.select('*').single();
  if (error) throw httpError(500, 'Unable to save onboarding step', error);

  res.json({ onboarding: data });
}

/**
 * POST /api/onboarding/:patientId/complete
 *
 * CRITICAL DIFFERENCE from old code:
 * Old code upserted a treatment plan on patient_id conflict.
 * This silently overwrote any existing active plan if the patient re-onboarded.
 *
 * New code:
 * - Creates a NEW draft plan only if NO draft plan already exists.
 * - If the patient already has a draft plan, it is left untouched.
 * - The active plan (if any) is NEVER touched.
 */
async function completeOnboarding(req, res) {
  const patient = await assertPatientAccess(req.userProfile, req.params.patientId);

  const { data: onboarding, error } = await adminClient
    .from('onboarding')
    .update({ is_complete: true, current_step: 6, completed_at: new Date().toISOString() })
    .eq('patient_id', patient.id)
    .eq('is_complete', false)
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to complete onboarding', error);

  const patientUpdate = extractPatientUpdate(onboarding);

  const { data: updatedPatient, error: patientError } = await adminClient
    .from('patients')
    .update(patientUpdate)
    .eq('id', patient.id)
    .select('*')
    .single();
  if (patientError) throw httpError(500, 'Unable to activate patient', patientError);

  // Risk baseline record
  await adminClient.from('risk_history').insert({
    patient_id: patient.id,
    risk_level: updatedPatient.current_risk_level || 'low',
    risk_score: updatedPatient.overall_risk_score || 10,
    trigger_reason: 'onboarding completed'
  });

  // ── Treatment plan: create a draft ONLY if no draft already exists ────────
  // Do NOT upsert — that would overwrite an existing plan.
  const { data: existingDraft } = await adminClient
    .from('treatment_plans')
    .select('id')
    .eq('patient_id', patient.id)
    .eq('status', 'draft')
    .maybeSingle();

  let treatmentPlan = existingDraft;
  if (!existingDraft) {
    const { data: newPlan, error: planError } = await adminClient
      .from('treatment_plans')
      .insert({
        patient_id: patient.id,
        doctor_id: updatedPatient.assigned_doctor_id || null,
        exercises: [],
        goals: updatedPatient.treatment_goals || [],
        restrictions: [],
        start_date: new Date().toISOString().slice(0, 10),
        status: 'draft'
      })
      .select('*')
      .single();
    if (planError) throw httpError(500, 'Unable to create draft treatment plan', planError);
    treatmentPlan = newPlan;
  }

  // Notify assigned doctor that a new patient has completed onboarding
  if (updatedPatient.assigned_doctor_id) {
    await adminClient.from('notifications').insert({
      patient_id: patient.id,
      doctor_id: updatedPatient.assigned_doctor_id,
      type: 'onboarding_complete',
      title: 'New patient ready for review',
      message: `A patient has completed onboarding and has a draft treatment plan awaiting your activation.`,
      priority: 'normal'
    });
  }

  res.json({ patient: updatedPatient, onboarding, treatmentPlan });
}

/**
 * GET /api/onboarding/:patientId
 */
async function getOnboarding(req, res) {
  const patient = await assertPatientAccess(req.userProfile, req.params.patientId);
  const { data, error } = await adminClient
    .from('onboarding')
    .select('*')
    .eq('patient_id', patient.id)
    .maybeSingle();
  if (error) throw httpError(500, 'Unable to load onboarding', error);
  res.json({ onboarding: data });
}

module.exports = {
  startOnboarding,
  updateStep,
  completeOnboarding,
  getOnboarding
};