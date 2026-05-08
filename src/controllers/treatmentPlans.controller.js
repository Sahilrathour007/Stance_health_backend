const { z } = require('zod');
const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { assertPatientAccess, getDoctorForUser } = require('../services/access.service');

// ─── Schemas ─────────────────────────────────────────────────────────────────

const exerciseSchema = z.object({
  name: z.string().min(1),
  sets: z.number().int().positive().optional(),
  reps: z.number().int().positive().optional(),
  frequency: z.string().optional(),   // e.g. "3x per week"
  duration_seconds: z.number().int().positive().optional(),
  notes: z.string().optional()
});

const createPlanSchema = z.object({
  patient_id: z.string().uuid(),
  exercises: z.array(exerciseSchema).default([]),
  goals: z.array(z.any()).default([]),
  restrictions: z.array(z.string()).default([]),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  clinical_notes: z.string().optional(),
  // Draft is the only valid status on creation.
  // Use the dedicated activation endpoint (PUT /:id/activate) to go live.
  status: z.literal('draft').default('draft')
});

const updatePlanSchema = z.object({
  exercises: z.array(exerciseSchema).optional(),
  goals: z.array(z.any()).optional(),
  restrictions: z.array(z.string()).optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  clinical_notes: z.string().optional(),
  status: z.enum(['draft', 'paused', 'completed']).optional()
  // 'active' is NOT allowed here — go through activatePlan()
});

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * POST /api/treatment-plans
 * Creates a DRAFT plan. Exercises can be empty at this stage.
 * Onboarding creates an empty draft automatically; the doctor then fills and activates it.
 *
 * We do NOT upsert on patient_id here — that was the bug.
 * A patient can have multiple plans over their rehab lifecycle (e.g. phase 1, phase 2, maintenance).
 * The active plan is the one with status='active'; there should only be one at a time.
 */
async function createTreatmentPlan(req, res) {
  if (req.userProfile.role === 'patient') throw httpError(403, 'Only doctors can create treatment plans');

  const body = createPlanSchema.parse(req.body);
  const patient = await assertPatientAccess(req.userProfile, body.patient_id);
  const doctor = req.userProfile.role === 'doctor' ? await getDoctorForUser(req.userProfile.id) : null;
  if (req.userProfile.role === 'doctor' && !doctor) throw httpError(404, 'Doctor profile not found');

  // Safety check: warn if there's already an active plan — but don't block it.
  // The doctor may be creating a new phase.
  const { data: activePlan } = await adminClient
    .from('treatment_plans')
    .select('id')
    .eq('patient_id', patient.id)
    .eq('status', 'active')
    .maybeSingle();

  const { data, error } = await adminClient
    .from('treatment_plans')
    .insert({
      patient_id: patient.id,
      doctor_id: doctor?.id || patient.assigned_doctor_id,
      exercises: body.exercises || [],
      goals: body.goals || [],
      restrictions: body.restrictions || [],
      clinical_notes: body.clinical_notes || null,
      start_date: body.start_date || null,
      end_date: body.end_date || null,
      status: 'draft'
    })
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to create treatment plan', error);

  res.status(201).json({
    treatmentPlan: data,
    warning: activePlan ? 'Patient already has an active plan. The new draft will not affect it until explicitly activated.' : null
  });
}

/**
 * PUT /api/treatment-plans/:id
 * Update exercises, goals, restrictions, clinical notes on a DRAFT or PAUSED plan.
 * Cannot be used to activate — use the dedicated endpoint.
 */
async function updateTreatmentPlan(req, res) {
  if (req.userProfile.role === 'patient') throw httpError(403, 'Only doctors can update treatment plans');

  const { data: plan, error: loadError } = await adminClient
    .from('treatment_plans')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (loadError) throw httpError(404, 'Treatment plan not found', loadError);
  await assertPatientAccess(req.userProfile, plan.patient_id);

  // Cannot edit a completed plan — create a new draft instead
  if (plan.status === 'completed') {
    throw httpError(400, 'Cannot edit a completed treatment plan. Create a new draft instead.');
  }

  // Cannot silently re-activate through this endpoint
  if (req.body.status === 'active') {
    throw httpError(400, 'Use PUT /api/treatment-plans/:id/activate to activate a plan');
  }

  const body = updatePlanSchema.parse(req.body);
  const update = {};
  for (const key of ['exercises', 'goals', 'restrictions', 'start_date', 'end_date', 'clinical_notes', 'status']) {
    if (Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined) {
      update[key] = body[key];
    }
  }

  if (!Object.keys(update).length) throw httpError(400, 'No valid fields to update');

  const { data, error } = await adminClient
    .from('treatment_plans')
    .update(update)
    .eq('id', req.params.id)
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to update treatment plan', error);
  res.json({ treatmentPlan: data });
}

/**
 * PUT /api/treatment-plans/:id/activate
 * The clinical activation gate. Doctor explicitly starts the programme.
 * - Marks any previously active plan as 'paused' first (one active plan per patient).
 * - Sets status='active', activated_at=now.
 * - Notifies the patient that their programme has started.
 * - Requires at least one exercise to be present — no activating empty plans.
 */
async function activatePlan(req, res) {
  if (req.userProfile.role === 'patient') throw httpError(403, 'Only doctors can activate treatment plans');

  const { data: plan, error: loadError } = await adminClient
    .from('treatment_plans')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (loadError) throw httpError(404, 'Treatment plan not found', loadError);
  await assertPatientAccess(req.userProfile, plan.patient_id);

  if (plan.status === 'active') throw httpError(400, 'Plan is already active');
  if (plan.status === 'completed') throw httpError(400, 'Cannot reactivate a completed plan');

  // Enforce non-empty exercises before going live
  if (!plan.exercises || plan.exercises.length === 0) {
    throw httpError(400, 'Cannot activate a plan with no exercises. Add at least one exercise first.');
  }

  // Pause any currently active plan for this patient
  await adminClient
    .from('treatment_plans')
    .update({ status: 'paused' })
    .eq('patient_id', plan.patient_id)
    .eq('status', 'active');

  // Accept optional clinical_notes override on activation
  const activationNotes = req.body?.clinical_notes;
  const updatePayload = {
    status: 'active',
    activated_at: new Date().toISOString(),
    start_date: plan.start_date || new Date().toISOString().slice(0, 10)
  };
  if (activationNotes) updatePayload.clinical_notes = activationNotes;

  const { data, error } = await adminClient
    .from('treatment_plans')
    .update(updatePayload)
    .eq('id', req.params.id)
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to activate treatment plan', error);

  // Notify patient — exercises are now unlocked in the portal
  await adminClient.from('notifications').insert({
    patient_id: plan.patient_id,
    doctor_id: plan.doctor_id || null,
    type: 'plan_activated',
    title: 'Your programme has started',
    message: `Your physiotherapist has activated your treatment plan. Your exercises are now available in your portal.`,
    priority: 'high'
  });

  res.json({ treatmentPlan: data });
}

/**
 * GET /api/treatment-plans/patient/:patientId
 * Returns all plans for a patient, sorted by created_at desc.
 * Useful for doctor dashboard to show draft + active + history.
 */
async function listPatientPlans(req, res) {
  const patient = await assertPatientAccess(req.userProfile, req.params.patientId);

  const { data, error } = await adminClient
    .from('treatment_plans')
    .select('*')
    .eq('patient_id', patient.id)
    .order('created_at', { ascending: false });
  if (error) throw httpError(500, 'Unable to load treatment plans', error);

  res.json({ treatmentPlans: data || [] });
}

module.exports = {
  createTreatmentPlan,
  updateTreatmentPlan,
  activatePlan,
  listPatientPlans
};