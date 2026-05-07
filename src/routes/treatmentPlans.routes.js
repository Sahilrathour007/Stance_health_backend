const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const controller = require('../controllers/treatmentPlans.controller');

const router = express.Router();

router.post('/', requireAuth, requireRole('doctor', 'admin'), asyncHandler(controller.createTreatmentPlan));
router.put('/:id', requireAuth, requireRole('doctor', 'admin'), asyncHandler(controller.updateTreatmentPlan));

module.exports = router;
