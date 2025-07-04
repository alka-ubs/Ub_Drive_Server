const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { getOrCreateDriveKey } = require('../controllers/driveKey.controller');


router.post('/drive-key', authMiddleware, getOrCreateDriveKey);

module.exports = router;
