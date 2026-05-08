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
  // Schedule fields — populated by the AI-draft suggest endpoint or set manually
  sessions_per_week: z.number().int().min(1).max(7).optional(),
  intensity: z.enum(['light', 'moderate', 'intensive']).optional(),
  duration_weeks: z.number().int().positive().optional(),
  rest_days: z.array(z.string()).default([]),
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
      sessions_per_week: body.sessions_per_week || null,
      intensity: body.intensity || null,
      duration_weeks: body.duration_weeks || null,
      rest_days: body.rest_days || [],
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

/**
 * POST /api/treatment-plans/suggest
 * Returns a rule-based exercise suggestion for a patient's condition.
 * NO database write — the doctor reviews and edits before saving.
 * Keyed on pain_location + primary_cohort from the patient record.
 * Now lifestyle-aware: equipment_access, exercise_window, travel_frequency,
 * behaviour_archetype all modify the base suggestion before returning.
 */
async function draftPlanFromPatient(req, res) {
  const { patient_id } = req.body;
  if (!patient_id) throw httpError(400, 'patient_id is required');

  const patient = await assertPatientAccess(req.userProfile, patient_id);

  // ── Condition signals ──────────────────────────────────────────────────────
  const painLocation = (patient.pain_location || patient.primary_concern || '').toLowerCase();
  const cohort       = (patient.primary_cohort || patient.cohort || '').toLowerCase();
  const painSeverity = parseFloat(patient.pain_severity || patient.current_pain || 5);

  // ── Lifestyle signals ──────────────────────────────────────────────────────
  const archetype       = (patient.behaviour_archetype   || '').toLowerCase();
  const equipmentAccess = (patient.equipment_access      || '').toLowerCase();
  const exerciseWindow  = (patient.exercise_window       || '').toLowerCase();
  const travelFrequency = (patient.travel_frequency      || '').toLowerCase();
  const treatmentGoals  = (patient.treatment_goals       || '').toLowerCase();

  // ── Base suggestion map ────────────────────────────────────────────────────
  const suggestionMap = {
    back_corporate:      { exercises: ['Cat-Cow', 'Bird Dog', 'Dead Bug', 'Hip Flexor Stretch', 'Glute Bridge'],              sessionsPerWeek: 3, intensity: 'moderate',  durationWeeks: 8  },
    back_athlete:        { exercises: ['Jefferson Curl', 'Romanian Deadlift', 'McGill Big 3', 'Pallof Press'],                sessionsPerWeek: 4, intensity: 'intensive', durationWeeks: 10 },
    back_senior:         { exercises: ['Seated Cat-Cow', 'Pelvic Tilt', 'Supine Knee Hug', 'Wall Angel'],                    sessionsPerWeek: 2, intensity: 'light',     durationWeeks: 12 },
    knee_corporate:      { exercises: ['Terminal Knee Extension', 'Step-Down', 'Wall Sit', 'Quad Set', 'SLR'],               sessionsPerWeek: 3, intensity: 'moderate',  durationWeeks: 8  },
    knee_athlete:        { exercises: ['Single-Leg Squat', 'Nordic Hamstring Curl', 'Lateral Step-Down', 'VMO Lunge'],       sessionsPerWeek: 4, intensity: 'intensive', durationWeeks: 12 },
    knee_senior:         { exercises: ['Seated Leg Extension', 'Mini Squat', 'Step-Up (Low)', 'Heel Raise'],                 sessionsPerWeek: 2, intensity: 'light',     durationWeeks: 10 },
    shoulder_corporate:  { exercises: ['Pendulum', 'Scapular Retraction', 'External Rotation Band', 'Doorway Stretch'],      sessionsPerWeek: 3, intensity: 'light',     durationWeeks: 8  },
    shoulder_athlete:    { exercises: ['Sleeper Stretch', 'YTW', 'Face Pull', 'Rotator Cuff Circuit'],                       sessionsPerWeek: 4, intensity: 'moderate',  durationWeeks: 10 },
    neck_corporate:      { exercises: ['Chin Tuck', 'Cervical Retraction', 'Upper Trap Stretch', 'Thoracic Extension'],      sessionsPerWeek: 3, intensity: 'light',     durationWeeks: 6  },
    hip_corporate:       { exercises: ['Hip Flexor Stretch', '90/90 Hip Stretch', 'Clamshell', 'Side-Lying Hip Abduction'],  sessionsPerWeek: 3, intensity: 'moderate',  durationWeeks: 8  },
    ankle_athlete:       { exercises: ['Single-Leg Balance', 'Calf Raise', 'Ankle Alphabet', 'Band Eversion'],               sessionsPerWeek: 4, intensity: 'moderate',  durationWeeks: 8  },
  };

  // Bodyweight-safe alternatives for patients with no gym access
  const bodyweightAlternatives = {
    back:     ['Dead Bug', 'Glute Bridge', 'Bird Dog', 'Pelvic Tilt', 'Knee-to-Chest Stretch'],
    knee:     ['Wall Sit', 'Straight Leg Raise', 'Quad Set', 'Step-Up (bodyweight)', 'Heel Raise'],
    shoulder: ['Wall Slide', 'Doorway Stretch', 'Scapular Retraction', 'Prone Y/T/W'],
    neck:     ['Chin Tuck', 'Upper Trap Stretch', 'Cervical Retraction', 'Thoracic Extension on Floor'],
    hip:      ['Hip Flexor Stretch', 'Clamshell', '90/90 Hip Stretch', 'Side-Lying Hip Abduction'],
    ankle:    ['Single-Leg Balance', 'Ankle Alphabet', 'Seated Calf Raise', 'Towel Toe Curl'],
  };

  // Exercises that require gym equipment and should be filtered out if no access
  const gymOnlyExercises = new Set([
    'Romanian Deadlift', 'Jefferson Curl', 'Nordic Hamstring Curl', 'Pallof Press',
    'Lateral Step-Down', 'VMO Lunge', 'Rotator Cuff Circuit', 'Face Pull',
    'External Rotation Band', 'Band Eversion',
  ]);

  // ── Key resolution ─────────────────────────────────────────────────────────
  const locationKey = painLocation.includes('back')    ? 'back'
    : painLocation.includes('knee')                    ? 'knee'
    : painLocation.includes('shoulder')                ? 'shoulder'
    : painLocation.includes('neck') || painLocation.includes('cervical') ? 'neck'
    : painLocation.includes('hip')                     ? 'hip'
    : painLocation.includes('ankle') || painLocation.includes('foot')    ? 'ankle'
    : 'back';

  const cohortKey = cohort.includes('sport') || cohort.includes('athlete') ? 'athlete'
    : cohort.includes('senior') || cohort.includes('elder')                ? 'senior'
    : 'corporate';

  const key = `${locationKey}_${cohortKey}`;
  // Deep-clone so we don't mutate the map
  const base       = suggestionMap[key] || suggestionMap['back_corporate'];
  let exercises    = [...base.exercises];
  let sessionsPerWeek = base.sessionsPerWeek;
  let intensity    = base.intensity;
  let durationWeeks = base.durationWeeks;

  // ── Severity adjustment ────────────────────────────────────────────────────
  if (painSeverity >= 7 && intensity === 'intensive') intensity = 'moderate';
  if (painSeverity >= 8 && intensity === 'moderate')  intensity = 'light';

  // ── Lifestyle adaptations (tracked for response transparency) ─────────────
  const lifestyleAdaptations = [];

  // 1. Equipment — no gym → replace gym-only moves with bodyweight alternatives
  const noGymAccess = equipmentAccess.includes('no equipment')
    || equipmentAccess.includes('home')
    || equipmentAccess.includes('bodyweight');

  if (noGymAccess) {
    const filtered = exercises.filter(ex => !gymOnlyExercises.has(ex));
    const removed   = exercises.filter(ex => gymOnlyExercises.has(ex));
    const alts      = (bodyweightAlternatives[locationKey] || []).filter(a => !filtered.includes(a));
    exercises = [...filtered, ...alts.slice(0, removed.length)];
    if (removed.length) {
      lifestyleAdaptations.push(`Equipment: replaced ${removed.length} gym-only exercise(s) with bodyweight alternatives (${equipmentAccess})`);
    }
  }

  // 2. Travel — frequent travellers can't maintain high session frequency
  const isFrequentTraveller = travelFrequency.includes('frequent')
    || travelFrequency.includes('2x')
    || travelFrequency.includes('weekly');

  if (isFrequentTraveller && sessionsPerWeek > 3) {
    sessionsPerWeek = Math.min(sessionsPerWeek, 3);
    lifestyleAdaptations.push(`Travel: sessions/week capped at 3 due to frequent travel (${travelFrequency})`);
  }

  // 3. Behaviour archetype — Overdoer gets hard load caps on every exercise note
  const isOverdoer = archetype.includes('overdoer') || archetype.includes('over-doer');
  const isAvoider  = archetype.includes('avoider');

  if (isOverdoer) {
    lifestyleAdaptations.push('Archetype (Overdoer): load-cap warning added to all exercise notes');
  }
  if (isAvoider && intensity === 'light') {
    // Avoiders need extra motivation scaffolding, not just light load
    lifestyleAdaptations.push('Archetype (Avoider): progressive difficulty noted — start minimum viable, build week-on-week');
  }

  // 4. Exercise window — evening-only → consolidate rest days to avoid thin spread
  const eveningOnly = exerciseWindow.includes('evening') || exerciseWindow.includes('night');
  let restDays = [];
  if (eveningOnly && sessionsPerWeek <= 3) {
    restDays = ['Sunday', 'Wednesday'];
    lifestyleAdaptations.push('Exercise window (evening-only): rest days set to Wed + Sun to consolidate sessions');
  }

  // ── Build final exercise objects ───────────────────────────────────────────
  const suggestedExercises = exercises.map(name => {
    let notes = '';
    if (isOverdoer) {
      notes = 'LOAD CAP: Do NOT increase load without clinical sign-off. Stop if pain > 3/10.';
    } else if (isAvoider) {
      notes = 'Start with minimum reps. Progress by 1 rep/set each week if pain-free.';
    }
    return {
      name,
      sets:      intensity === 'light' ? 2 : 3,
      reps:      intensity === 'intensive' ? 12 : 10,
      frequency: `${sessionsPerWeek}x per week`,
      notes
    };
  });

  res.json({
    suggestedExercises,
    suggestedSchedule: {
      sessionsPerWeek,
      intensity,
      durationWeeks,
      restDays
    },
    lifestyleAdaptations,
    derivedFrom: {
      painLocation: locationKey,
      cohort: cohortKey,
      painSeverity,
      equipmentAccess: equipmentAccess || null,
      exerciseWindow:  exerciseWindow  || null,
      travelFrequency: travelFrequency || null,
      behaviourArchetype: archetype    || null,
    }
  });
}

module.exports = {
  createTreatmentPlan,
  updateTreatmentPlan,
  activatePlan,
  listPatientPlans,
  draftPlanFromPatient
};