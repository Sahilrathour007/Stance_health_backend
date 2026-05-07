const { adminClient } = require('../config/supabase');
const httpError = require('../utils/httpError');
const { calculateRiskRules } = require('./risk.rules');

function scoresFromCheckIn(checkIn) {
  const completionRate = Number(checkIn.completion_rate ?? 100);
  const painLevel = Number(checkIn.pain_level ?? 0);
  const confidenceScore = Number(checkIn.confidence_score ?? 10);

  return {
    bciScore: Number(completionRate.toFixed(2)),
    sesScore: Number((confidenceScore * 10).toFixed(2)),
    spsScore: Number(Math.max(0, 100 - painLevel * 10).toFixed(2))
  };
}

async function recalculateRiskForCheckIn(checkIn) {
  const result = calculateRiskRules({
    completionRate: checkIn.completion_rate,
    painLevel: checkIn.pain_level,
    confidenceScore: checkIn.confidence_score,
    obstacle: checkIn.obstacle,
    symptoms: checkIn.symptoms || []
  });
  const scores = scoresFromCheckIn(checkIn);

  const { error: historyError } = await adminClient.from('risk_history').insert({
    patient_id: checkIn.patient_id,
    risk_level: result.riskLevel,
    risk_score: result.riskScore,
    bci_score: scores.bciScore,
    ses_score: scores.sesScore,
    sps_score: scores.spsScore,
    trigger_reason: result.triggerReason
  });
  if (historyError) throw httpError(500, 'Unable to write risk history', historyError);

  const patientStatus = result.riskLevel === 'high' || result.riskLevel === 'critical' ? 'at_risk' : 'active';
  const { data: patient, error: patientError } = await adminClient
    .from('patients')
    .update({
      current_risk_level: result.riskLevel,
      bci_score: scores.bciScore,
      ses_score: scores.sesScore,
      sps_score: scores.spsScore,
      overall_risk_score: result.riskScore,
      status: patientStatus
    })
    .eq('id', checkIn.patient_id)
    .select('*')
    .single();
  if (patientError) throw httpError(500, 'Unable to update patient risk', patientError);

  if (result.riskLevel === 'high' || result.riskLevel === 'critical') {
    await adminClient.from('notifications').insert({
      patient_id: checkIn.patient_id,
      doctor_id: patient.assigned_doctor_id,
      type: 'risk_alert',
      title: `${result.riskLevel.toUpperCase()} risk patient`,
      message: result.triggerReason,
      priority: result.riskLevel === 'critical' ? 'urgent' : 'high'
    });
  }

  return {
    ...result,
    ...scores,
    patient
  };
}

module.exports = {
  recalculateRiskForCheckIn
};
