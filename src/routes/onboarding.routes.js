const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const controller = require('../controllers/onboarding.controller');

const router = express.Router();

router.post('/start', requireAuth, requireRole('patient', 'admin'), asyncHandler(controller.startOnboarding));
router.put('/:patientId/step/:stepNumber', requireAuth, asyncHandler(controller.updateStep));
router.post('/:patientId/complete', requireAuth, asyncHandler(controller.completeOnboarding));
router.get('/:patientId', requireAuth, asyncHandler(controller.getOnboarding));

module.exports = router;
