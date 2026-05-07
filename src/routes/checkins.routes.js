const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/checkins.controller');

const router = express.Router();

router.post('/', requireAuth, asyncHandler(controller.createCheckIn));

module.exports = router;
