const CRITICAL_SYMPTOMS = [
  'numbness',
  'weakness',
  'bowel',
  'bladder',
  'radiating',
  'shooting pain'
];

function hasCriticalSymptom(symptoms = []) {
  return symptoms.some((symptom) => {
    const value = String(symptom).toLowerCase();
    return CRITICAL_SYMPTOMS.some((flag) => value.includes(flag));
  });
}

function calculateRiskRules(input) {
  const completionRate = Number(input.completionRate ?? 100);
  const painLevel = Number(input.painLevel ?? 0);
  const confidenceScore = Number(input.confidenceScore ?? 10);
  const symptoms = input.symptoms || [];
  const obstacle = String(input.obstacle || '').toLowerCase();

  let riskScore = 0;
  const reasons = [];

  riskScore += Math.max(0, painLevel) * 8;
  riskScore += Math.max(0, 100 - completionRate) * 0.35;
  riskScore += Math.max(0, 10 - confidenceScore) * 4;

  if (hasCriticalSymptom(symptoms)) {
    riskScore += 30;
    reasons.push('red flag symptom reported');
  }

  if (painLevel >= 8) reasons.push('pain level is severe');
  if (completionRate < 40) reasons.push('completion rate below 40%');
  if (confidenceScore <= 3) reasons.push('low confidence score');
  if (obstacle.includes('time') || obstacle.includes('work')) {
    riskScore += 5;
    reasons.push('adherence obstacle reported');
  }

  let riskLevel = 'low';
  if (riskScore >= 85 || (painLevel >= 8 && completionRate < 40) || hasCriticalSymptom(symptoms)) {
    riskLevel = 'critical';
  } else if (riskScore >= 65 || painLevel >= 7 || completionRate < 45) {
    riskLevel = 'high';
  } else if (riskScore >= 40 || painLevel >= 5 || completionRate < 65 || confidenceScore <= 5) {
    riskLevel = 'moderate';
  }

  return {
    riskLevel,
    riskScore: Number(Math.min(100, riskScore).toFixed(2)),
    triggerReason: reasons.length ? reasons.join('; ') : 'routine weekly check-in'
  };
}

module.exports = {
  calculateRiskRules
};
