const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const controller = require('../controllers/public.controller');

const router = express.Router();

router.post('/profile', asyncHandler(controller.savePublicProfile));
router.post('/appointments', asyncHandler(controller.createPublicAppointment));

module.exports = router;
