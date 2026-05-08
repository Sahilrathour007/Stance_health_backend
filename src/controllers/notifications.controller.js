const { z } = require('zod');
const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { assertPatientAccess, getDoctorForUser } = require('../services/access.service');

// ─── Schemas ─────────────────────────────────────────────────────────────────

const notificationSchema = z.object({
  patient_id: z.string().uuid(),
  doctor_id: z.string().uuid().optional(),
  type: z.string(),
  title: z.string(),
  message: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal')
});

// ─── Automated Notification Engine ───────────────────────────────────────────
// This is the automation layer the product spec calls for.
// Doctors should only intervene for high-risk/override cases.
// Everything else is automated from here.

/**
 * Cohort-aware message templates.
 * Keys: event_type + cohort variant.
 * Falls back to 'default' if no cohort match.
 */
const TEMPLATES = {
  // ── After plan activation ──
  plan_activated: {
    corporate: {
      title: 'Your programme is ready',
      message: 'Your physiotherapist has built a plan around your desk-work lifestyle. Start today — even 10 minutes matters.'
    },
    athlete: {
      title: 'Training plan activated',
      message: 'Your physio has activated your performance recovery plan. Follow the programme to get back to full training.'
    },
    gym: {
      title: 'Your rehab plan is live',
      message: 'Your programme is active. Follow the exercises before your next gym session for best results.'
    },
    default: {
      title: 'Your programme has started',
      message: 'Your physiotherapist has activated your treatment plan. Your exercises are now available in your portal.'
    }
  },

  // ── Weekly check-in reminder ──
  checkin_reminder: {
    corporate: {
      title: 'Quick check-in (2 min)',
      message: 'How is your body feeling this week? Your physio monitors these — it matters.'
    },
    athlete: {
      title: 'Weekly performance check-in',
      message: 'Log your training response and pain levels for your physio review.'
    },
    default: {
      title: 'Time for your weekly check-in',
      message: 'Log how you\'re feeling this week. Your physiotherapist reviews these to adjust your plan.'
    }
  },

  // ── Pain spike alert ──
  pain_spike: {
    default: {
      title: 'Pain increase flagged',
      message: 'Your pain level was higher than usual this week. Your physiotherapist has been notified and will review your plan.',
      priority: 'high'
    }
  },

  // ── Low adherence warning ──
  low_adherence: {
    corporate: {
      title: 'You\'ve missed some sessions',
      message: 'Consistency matters more than intensity. Even a 10-minute session counts — open your portal to check in.'
    },
    default: {
      title: 'Don\'t let progress slip',
      message: 'You\'ve missed some exercises this week. Your plan is still waiting — pick it back up today.'
    }
  },

  // ── Discharge / reactivation ──
  reactivation: {
    default: {
      title: 'Check in with your physio',
      message: 'It\'s been a while since your last session. If your symptoms have returned or you want a review, book a follow-up.'
    }
  },

  // ── Appointment reminders ──
  appointment_reminder_24h: {
    default: {
      title: 'Appointment tomorrow',
      message: 'Your physiotherapy appointment is tomorrow. Reply to this if you need to reschedule.'
    }
  },

  appointment_reminder_1h: {
    default: {
      title: 'Appointment in 1 hour',
      message: 'Your appointment starts in about an hour. See you soon.'
    }
  }
};

/**
 * Resolve the right template for a given event type and patient cohort.
 * Returns { title, message, priority }.
 */
function resolveTemplate(eventType, cohort = 'default', overrides = {}) {
  const event = TEMPLATES[eventType];
  if (!event) return null;
  const template = event[cohort] || event['default'];
  if (!template) return null;
  return {
    title: overrides.title || template.title,
    message: overrides.message || template.message,
    priority: overrides.priority || template.priority || 'normal'
  };
}

// ─── Auto-Trigger Functions ───────────────────────────────────────────────────
// These are called internally by other controllers (check-ins, jobs, etc.)
// NOT exposed as HTTP endpoints directly — they are the automation backbone.

/**
 * Send a cohort-aware automated notification to a patient.
 * Call this from: check-in controller (pain spike), cron jobs (reminders), etc.
 */
async function sendAutomatedNotification(patientId, eventType, overrides = {}) {
  // Load patient with cohort info
  const { data: patient, error: patientError } = await adminClient
    .from('patients')
    .select('id, assigned_doctor_id, primary_cohort, secondary_cohort')
    .eq('id', patientId)
    .maybeSingle();
  if (patientError || !patient) return null;  // Non-fatal in automation context

  const cohort = patient.primary_cohort || 'default';
  const template = resolveTemplate(eventType, cohort, overrides);
  if (!template) return null;

  const { data, error } = await adminClient
    .from('notifications')
    .insert({
      patient_id: patientId,
      doctor_id: patient.assigned_doctor_id || null,
      type: eventType,
      title: template.title,
      message: template.message,
      priority: template.priority
    })
    .select('*')
    .single();

  if (error) {
    console.error(`[notifications] Failed to send automated '${eventType}' to patient ${patientId}:`, error);
    return null;
  }
  return data;
}

/**
 * Escalate to doctor: used when automation detects a risk event that needs human review.
 * Pain spike > threshold, confidence collapse, missed check-ins > 2 weeks.
 */
async function escalateToDoctor(patientId, reason, priority = 'high') {
  const { data: patient } = await adminClient
    .from('patients')
    .select('id, assigned_doctor_id, users(name)')
    .eq('id', patientId)
    .maybeSingle();
  if (!patient?.assigned_doctor_id) return null;

  const { data } = await adminClient
    .from('notifications')
    .insert({
      patient_id: patientId,
      doctor_id: patient.assigned_doctor_id,
      type: 'escalation',
      title: 'Patient needs review',
      message: `${patient.users?.name || 'A patient'}: ${reason}`,
      priority
    })
    .select('*')
    .single();

  return data;
}

// ─── HTTP Controllers ─────────────────────────────────────────────────────────

/**
 * POST /api/notifications
 * Manual notification — doctor or admin sends a direct message.
 * Routine automated messages should use sendAutomatedNotification() instead.
 */
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

/**
 * PUT /api/notifications/:id/read
 */
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
      if (!doctor || existing.doctor_id !== doctor.id) {
        throw httpError(403, 'You do not have access to this notification');
      }
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

/**
 * GET /api/notifications/templates
 */
async function listTemplates(_req, res) {
  const { data, error } = await adminClient
    .from('message_templates')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false });
  if (error) throw httpError(500, 'Unable to load message templates', error);
  res.json({ templates: data });
}

/**
 * POST /api/notifications/templates
 */
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
  // HTTP handlers
  sendNotification,
  markRead,
  listTemplates,
  createTemplate,
  // Automation functions — imported by other controllers and jobs
  sendAutomatedNotification,
  escalateToDoctor,
  resolveTemplate
};