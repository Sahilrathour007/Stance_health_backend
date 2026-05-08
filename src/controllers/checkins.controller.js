const { z } = require('zod');
const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { assertPatientAccess } = require('../services/access.service');
const { recalculateRiskForCheckIn } = require('../services/risk.service');

const checkInSchema = z.object({
  patient_id: z.string().uuid(),
  completion_rate: z.number().int().min(0).max(100),
  pain_level: z.number().int().min(0).max(10),
  confidence_score: z.number().int().min(0).max(10),
  obstacle: z.string().optional(),
  mood: z.enum(['great', 'good', 'neutral', 'bad', 'terrible']).optional(),
  notes: z.string().optional(),
  symptoms: z.array(z.string()).optional(),
  week_number: z.number().int().positive().optional(),
  check_in_type: z.enum(['daily', 'weekly', 'monthly']).default('weekly')
});

async function createCheckIn(req, res) {
  const body = checkInSchema.parse(req.body);
  await assertPatientAccess(req.userProfile, body.patient_id);

  const { data: checkIn, error } = await adminClient
    .from('check_ins')
    .insert({
      patient_id: body.patient_id,
      completion_rate: body.completion_rate,
      pain_level: body.pain_level,
      confidence_score: body.confidence_score,
      obstacle: body.obstacle || null,
      mood: body.mood || null,
      notes: body.notes || null,
      symptoms: body.symptoms || [],
      week_number: body.week_number || null,
      check_in_type: body.check_in_type
    })
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to save check-in', error);

  const risk = await recalculateRiskForCheckIn(checkIn);
  res.status(201).json({ checkIn, risk });
}

async function listPatientCheckIns(req, res) {
  const patient = await assertPatientAccess(req.userProfile, req.params.patientId);
  const { data, error } = await adminClient
    .from('check_ins')
    .select('*')
    .eq('patient_id', patient.id)
    .order('submitted_at', { ascending: false });
  if (error) throw httpError(500, 'Unable to load check-ins', error);
  res.json({ checkIns: data });
}

module.exports = {
  createCheckIn,
  listPatientCheckIns
};