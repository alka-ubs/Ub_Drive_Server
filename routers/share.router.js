const express = require('express');
const router = express.Router();
const shareController = require('../controllers/sharewith.controller');
const authMiddleware = require('../middleware/auth.middleware');


router.post('/create', authMiddleware, shareController.shareItem);
router.get('/all', authMiddleware, shareController.listSharedItems);
router.get('/GetById:id', authMiddleware, shareController.getShareDetails);
router.put('/update/:id', authMiddleware, shareController.updateSharePermissions);
router.delete('/delete/:id', authMiddleware, shareController.removeShare);

module.exports = router;