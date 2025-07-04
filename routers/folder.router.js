const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const { createFolder, getFolderContents, renameFolder, deleteFolder, getAllFolders, uploadFolderStructure, updateFolderState, permanentDeleteFolder } = require('../controllers/folder.controller');
const router = express.Router();

router.post('/create',authMiddleware, createFolder);
router.post('/upload', authMiddleware,uploadFolderStructure );
router.get('/get',authMiddleware, getAllFolders);
router.get('/getById/:id',authMiddleware, getFolderContents);
router.put('/update/:id',authMiddleware, renameFolder);
router.delete('/delete/:id',authMiddleware, deleteFolder);
router.put('/update/:id/:field/:value',authMiddleware, updateFolderState);
router.delete('/permanent/:fileId',authMiddleware,permanentDeleteFolder);

module.exports = router;
