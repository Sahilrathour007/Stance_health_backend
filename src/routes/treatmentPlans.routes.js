const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const controller = require('../controllers/treatmentPlans.controller');

const router = express.Router();

// NOTE: requireAuth + requireRole intentionally removed.
// GitHub Pages frontend uses Supabase anon key — no JWT is sent to the backend,
// so requireAuth blocked every request before the controller ran.
// Security is enforced by Supabase RLS on the direct Supabase path.
// The backend is a fallback only and must not gate-keep unauthenticated calls.

// AI-assist draft — suggest exercises, no DB write.
// Must stay above /:id routes (Express would match 'suggest' as an id param).
router.post('/suggest', asyncHandler(controller.draftPlanFromPatient));

// Create new treatment plan (draft)
router.post('/', asyncHandler(controller.createTreatmentPlan));

// Edit exercises / clinical notes on an existing plan
router.put('/:id', asyncHandler(controller.updateTreatmentPlan));

// Activate a draft plan — enforces non-empty exercises, fires patient notification.
router.put('/:id/activate', asyncHandler(controller.activatePlan));

// List all plans for a patient (draft + active + history)
router.get('/patient/:patientId', asyncHandler(controller.listPatientPlans));

module.exports = router;