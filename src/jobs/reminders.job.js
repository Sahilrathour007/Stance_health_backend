const { adminClient } = require('../config/supabase');

async function createWeeklyCheckInReminders() {
  const { data: patients, error } = await adminClient
    .from('patients')
    .select('id, assigned_doctor_id, users(name)')
    .eq('status', 'active');
  if (error) throw error;

  if (!patients.length) return { created: 0 };

  const notifications = patients.map((patient) => ({
    patient_id: patient.id,
    doctor_id: patient.assigned_doctor_id,
    type: 'weekly_checkin',
    title: 'Weekly check-in due',
    message: 'Please complete your weekly recovery check-in.',
    priority: 'normal'
  }));

  const { error: insertError } = await adminClient.from('notifications').insert(notifications);
  if (insertError) throw insertError;

  return { created: notifications.length };
}

module.exports = {
  createWeeklyCheckInReminders
};
