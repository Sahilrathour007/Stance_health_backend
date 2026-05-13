const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const patientController = require('../controllers/patients.controller');
const checkInController = require('../controllers/checkins.controller');
const dailyProgressController = require('../controllers/dailyProgress.controller');

const router = express.Router();

// ── Patient self-service ──────────────────────────────────────────────────────
router.get('/',    requireAuth, asyncHandler(patientController.listPatients));
router.get('/me',  requireAuth, asyncHandler(patientController.getMyPatient));
router.put('/:id', requireAuth, asyncHandler(patientController.updatePatient));

// ── Daily progress — must be above /:id to avoid param collision ──────────────
// POST: patient submits exercise completion + optional pain/confidence after session
// GET:  patient fetches last 30 days of daily progress (for Reports page)
router.post('/me/daily-progress', requireAuth, asyncHandler(dailyProgressController.submitDailyProgress));
router.get('/me/daily-progress',  requireAuth, asyncHandler(dailyProgressController.getMyDailyProgress));

// ── Patient detail routes ─────────────────────────────────────────────────────
router.get('/:id',                requireAuth, asyncHandler(patientController.getPatient));
router.get('/:id/check-ins',      requireAuth, asyncHandler(checkInController.listPatientCheckIns));
router.get('/:id/treatment-plan', requireAuth, asyncHandler(patientController.getTreatmentPlan));
router.get('/:id/appointments',   requireAuth, asyncHandler(patientController.getAppointments));
router.get('/:id/notifications',  requireAuth, asyncHandler(patientController.getNotifications));

module.exports = router;
