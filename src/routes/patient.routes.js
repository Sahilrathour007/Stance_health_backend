const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const patientController = require('../controllers/patients.controller');
const checkInController = require('../controllers/checkins.controller');

const router = express.Router();

router.get('/:id', requireAuth, asyncHandler(patientController.getPatient));
router.put('/:id', requireAuth, asyncHandler(patientController.updatePatient));
router.get('/:id/check-ins', requireAuth, asyncHandler(checkInController.listPatientCheckIns));
router.get('/:id/treatment-plan', requireAuth, asyncHandler(patientController.getTreatmentPlan));
router.get('/:id/appointments', requireAuth, asyncHandler(patientController.getAppointments));
router.get('/:id/notifications', requireAuth, asyncHandler(patientController.getNotifications));

module.exports = router;
