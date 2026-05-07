const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const controller = require('../controllers/doctor.controller');

const router = express.Router();

router.get('/dashboard', requireAuth, requireRole('doctor', 'admin'), asyncHandler(controller.getDashboard));

module.exports = router;
