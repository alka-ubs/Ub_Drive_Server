const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { uploadFile, getFile, getFiles, downloadFile, updateFile, deleteFile, copyFile, getDrive, updateFileState, getStarred, getTrash, getRecent, renameFile, getFileContent, getDriveData, permanentDeleteFile } = require('../controllers/file.controller');


// File operations
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() }); // Store in memory (or use diskStorage)

// Update the route to use multer 

// Correct way to make a parameter optional
router.post("/upload/:folderId", authMiddleware, upload.single("file"), uploadFile);
router.post("/upload", authMiddleware, upload.single("file"), uploadFile);
router.get('/getFile', authMiddleware, getFiles);
router.get('/getFileContent/:fileId', authMiddleware, getFileContent);
router.get('/getById/:id', authMiddleware, getFile);
router.get('/content/:id', authMiddleware, downloadFile);
router.put('/update/:id', authMiddleware, updateFile);
router.delete('/delete/:id', authMiddleware, deleteFile);
router.post('/copy/:id', authMiddleware, copyFile);
router.get('/get/drive', authMiddleware, getDrive);
router.get('/get/recent',authMiddleware,getRecent);
router.get('/get/starred',authMiddleware,getStarred);
router.get('/get/trash',authMiddleware,getTrash);
router.put('/update/rename/:id',authMiddleware,renameFile);
router.put('/update/:id/:field/:value',authMiddleware, updateFileState);
router.get('/get/master',authMiddleware,getDriveData);
router.delete('/permanent/:fileId',authMiddleware,permanentDeleteFile);

module.exports = router;