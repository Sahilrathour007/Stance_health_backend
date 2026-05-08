const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/checkins.controller');

const router = express.Router();

router.post('/', requireAuth, asyncHandler(controller.createCheckIn));

// NEW: List check-ins for a patient — was only in patient.routes.js before.
// Doctor dashboard needs this directly without going through patient routes.
router.get('/patient/:patientId', requireAuth, asyncHandler(controller.listPatientCheckIns));

module.exports = router;