const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const controller = require('../controllers/appointments.controller');

const router = express.Router();

router.post('/', requireAuth, asyncHandler(controller.createAppointment));
router.get('/', requireAuth, asyncHandler(controller.listAppointments));
router.get('/:id', requireAuth, asyncHandler(controller.getAppointment));
router.put('/:id', requireAuth, asyncHandler(controller.updateAppointment));
router.delete('/:id', requireAuth, asyncHandler(controller.deleteAppointment));

module.exports = router;
