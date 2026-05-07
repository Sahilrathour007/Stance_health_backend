const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const controller = require('../controllers/notifications.controller');

const router = express.Router();

router.get('/message-templates', requireAuth, requireRole('doctor', 'admin'), asyncHandler(controller.listTemplates));
router.post('/message-templates', requireAuth, requireRole('doctor', 'admin'), asyncHandler(controller.createTemplate));
router.post('/send', requireAuth, requireRole('doctor', 'admin'), asyncHandler(controller.sendNotification));
router.put('/:id/read', requireAuth, asyncHandler(controller.markRead));

module.exports = router;
