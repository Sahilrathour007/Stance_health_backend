const { z } = require('zod');
const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { assertPatientAccess, getDoctorForUser } = require('../services/access.service');

const notificationSchema = z.object({
  patient_id: z.string().uuid(),
  doctor_id: z.string().uuid().optional(),
  type: z.string(),
  title: z.string(),
  message: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal')
});

async function sendNotification(req, res) {
  const body = notificationSchema.parse(req.body);
  const patient = await assertPatientAccess(req.userProfile, body.patient_id);
  const doctor = req.userProfile.role === 'doctor' ? await getDoctorForUser(req.userProfile.id) : null;
  const { data, error } = await adminClient
    .from('notifications')
    .insert({
      ...body,
      doctor_id: req.userProfile.role === 'admin'
        ? body.doctor_id || patient.assigned_doctor_id
        : doctor?.id || patient.assigned_doctor_id
    })
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to send notification', error);
  res.status(201).json({ notification: data });
}

async function markRead(req, res) {
  const { data: existing, error: loadError } = await adminClient
    .from('notifications')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (loadError) throw httpError(404, 'Notification not found', loadError);

  if (req.userProfile.role !== 'admin') {
    if (existing.patient_id) {
      await assertPatientAccess(req.userProfile, existing.patient_id);
    } else if (req.userProfile.role === 'doctor') {
      const doctor = await getDoctorForUser(req.userProfile.id);
      if (!doctor || existing.doctor_id !== doctor.id) throw httpError(403, 'You do not have access to this notification');
    } else {
      throw httpError(403, 'You do not have access to this notification');
    }
  }

  const { data, error } = await adminClient
    .from('notifications')
    .update({ is_read: true })
    .eq('id', req.params.id)
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to mark notification read', error);
  res.json({ notification: data });
}

async function listTemplates(_req, res) {
  const { data, error } = await adminClient
    .from('message_templates')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false });
  if (error) throw httpError(500, 'Unable to load message templates', error);
  res.json({ templates: data });
}

async function createTemplate(req, res) {
  const body = z.object({
    type: z.string().min(1),
    cohort: z.string().optional().nullable(),
    subject: z.string().optional().nullable(),
    content: z.string().min(1),
    is_active: z.boolean().default(true)
  }).parse(req.body);

  const { data, error } = await adminClient
    .from('message_templates')
    .insert(body)
    .select('*')
    .single();
  if (error) throw httpError(500, 'Unable to create message template', error);
  res.status(201).json({ template: data });
}

module.exports = {
  sendNotification,
  markRead,
  listTemplates,
  createTemplate
};
