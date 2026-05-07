const { z } = require('zod');
const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { assertPatientAccess, getPatientForUser } = require('../services/access.service');

const stepSchema = z.object({
  data: z.record(z.any())
});

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

  const { data, error } = await query
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to save onboarding step', error);

  res.json({ onboarding: data });
}

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

  return {
    age: step1.age ?? null,
    gender: oneOf(step1.gender, ['male', 'female', 'other']),
    occupation: step1.occupation ?? null,
    pain_location: step2.pain_location ?? step2.painLocation ?? null,
    pain_severity: step2.pain_severity ?? step2.painSeverity ?? null,
    onset_type: oneOf(step2.onset_type ?? step2.onsetType, ['sudden', 'gradual']),
    pain_duration: step2.pain_duration ?? step2.painDuration ?? null,
    current_medications: toArray(step3.current_medications ?? step3.medications),
    past_surgeries: toArray(step3.past_surgeries ?? step3.surgeries),
    comorbidities: toArray(step3.comorbidities),
    treatment_goals: toArray(step5.treatment_goals ?? step5.goals),
    cohort: oneOf(step2.cohort, ['acute', 'chronic', 'post_surgical', 'preventive']),
    status: 'active',
    onboarded_at: new Date().toISOString()
  };
}

async function completeOnboarding(req, res) {
  const patient = await assertPatientAccess(req.userProfile, req.params.patientId);

  const { data: onboarding, error } = await adminClient
    .from('onboarding')
    .update({ is_complete: true, current_step: 6, completed_at: new Date().toISOString() })
    .eq('patient_id', patient.id)
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to complete onboarding', error);

  const { data: doctor } = await adminClient
    .from('doctors')
    .select('id')
    .limit(1)
    .maybeSingle();

  const patientUpdate = extractPatientUpdate(onboarding);
  if (doctor && !patient.assigned_doctor_id) patientUpdate.assigned_doctor_id = doctor.id;

  const { data: updatedPatient, error: patientError } = await adminClient
    .from('patients')
    .update(patientUpdate)
    .eq('id', patient.id)
    .select('*')
    .single();
  if (patientError) throw httpError(500, 'Unable to activate patient', patientError);

  await adminClient.from('risk_history').insert({
    patient_id: patient.id,
    risk_level: updatedPatient.current_risk_level || 'low',
    risk_score: updatedPatient.overall_risk_score || 10,
    trigger_reason: 'onboarding completed'
  });

  await adminClient.from('treatment_plans').upsert({
    patient_id: patient.id,
    doctor_id: updatedPatient.assigned_doctor_id,
    exercises: [],
    goals: updatedPatient.treatment_goals || [],
    restrictions: [],
    start_date: new Date().toISOString().slice(0, 10),
    status: 'draft'
  }, { onConflict: 'patient_id' });

  res.json({ patient: updatedPatient, onboarding });
}

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
