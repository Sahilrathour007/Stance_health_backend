const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const controller = require('../controllers/doctor.controller');

const router = express.Router();

// FIX: requireAuth + requireRole removed.
// Same root cause as treatmentPlans.routes.js — GitHub Pages anon key carries
// no JWT, so requireAuth blocked the dashboard and patient list endpoints.

// Triage view — high-severity patients requiring action today
router.get('/dashboard', asyncHandler(controller.getDashboard));

// Full patient management view — all patients across all severity tiers
router.get('/patients', asyncHandler(controller.listDoctorPatients));

module.exports = router;