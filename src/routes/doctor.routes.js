const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const controller = require('../controllers/doctor.controller');

const router = express.Router();

router.get('/dashboard', requireAuth, requireRole('doctor', 'admin'), asyncHandler(controller.getDashboard));

// NEW: Full patient list — separate from dashboard.
// Dashboard = triage (act now). This = full management view (all patients).
router.get('/patients', requireAuth, requireRole('doctor', 'admin'), asyncHandler(controller.listDoctorPatients));

module.exports = router;