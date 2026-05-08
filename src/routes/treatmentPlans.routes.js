const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const controller = require('../controllers/treatmentPlans.controller');

const router = express.Router();

router.post('/', requireAuth, requireRole('doctor', 'admin'), asyncHandler(controller.createTreatmentPlan));
router.put('/:id', requireAuth, requireRole('doctor', 'admin'), asyncHandler(controller.updateTreatmentPlan));

// NEW: Dedicated activation endpoint — separate from update intentionally.
// Enforces non-empty exercises, pauses existing active plan, fires patient notification.
router.put('/:id/activate', requireAuth, requireRole('doctor', 'admin'), asyncHandler(controller.activatePlan));

// NEW: List all plans for a patient (draft + active + history).
// Used by doctor dashboard to show draft queue.
router.get('/patient/:patientId', requireAuth, asyncHandler(controller.listPatientPlans));

module.exports = router;