const { z } = require('zod');
const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { assertPatientAccess, getDoctorForUser } = require('../services/access.service');

const planSchema = z.object({
  patient_id: z.string().uuid(),
  exercises: z.array(z.any()).default([]),
  goals: z.array(z.any()).default([]),
  restrictions: z.array(z.string()).default([]),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  status: z.enum(['draft', 'active', 'completed', 'paused']).default('draft')
});

async function createTreatmentPlan(req, res) {
  const body = planSchema.parse(req.body);
  const patient = await assertPatientAccess(req.userProfile, body.patient_id);
  if (req.userProfile.role === 'patient') throw httpError(403, 'Only doctors can create treatment plans');
  const doctor = req.userProfile.role === 'doctor' ? await getDoctorForUser(req.userProfile.id) : null;
  if (req.userProfile.role === 'doctor' && !doctor) throw httpError(404, 'Doctor profile not found');

  const { data, error } = await adminClient
    .from('treatment_plans')
    .upsert({
      ...body,
      patient_id: patient.id,
      doctor_id: doctor?.id || patient.assigned_doctor_id
    }, { onConflict: 'patient_id' })
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to save treatment plan', error);
  res.status(201).json({ treatmentPlan: data });
}

async function updateTreatmentPlan(req, res) {
  const { data: plan, error: loadError } = await adminClient
    .from('treatment_plans')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (loadError) throw httpError(404, 'Treatment plan not found', loadError);
  await assertPatientAccess(req.userProfile, plan.patient_id);
  if (req.userProfile.role === 'patient') throw httpError(403, 'Only doctors can update treatment plans');

  const allowed = ['exercises', 'goals', 'restrictions', 'start_date', 'end_date', 'status'];
  const update = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(req.body, key)) update[key] = req.body[key];

  const { data, error } = await adminClient
    .from('treatment_plans')
    .update(update)
    .eq('id', req.params.id)
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to update treatment plan', error);
  res.json({ treatmentPlan: data });
}

module.exports = {
  createTreatmentPlan,
  updateTreatmentPlan
};
