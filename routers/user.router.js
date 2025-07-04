const { createUser, loginUser, getProfile, addUserToBlock, addUserToSpam, logoutUser, checkSession, updatePreferences, updateProfile, updatePassword, updateAvatar } = require("../controllers/user.controller");
const authenticate = require("../middleware/auth.middleware");
const { body, validationResult } = require('express-validator');
const router = require("express").Router();

const multer = require('multer');
const path = require('path');

// Configure multer storage
const storage = multer.memoryStorage(); // or diskStorage for saving files to disk

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // limit: 5MB
  fileFilter: (req, file, cb) => {
    // Accept images only
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only images are allowed!'), false);
    }
    cb(null, true);
  }
});

// Your route
router.put('/updateAvtar', authenticate, updateAvatar);


  

router.post("/register",  createUser);
router.post("/login",  loginUser);
router.post("/logout", authenticate,logoutUser);
router.get("/profile", authenticate, getProfile);
router.post("/block-email", authenticate, addUserToBlock);
router.post("/spam-email", authenticate, addUserToSpam);
router.get("/session", checkSession);
router.post("/update-preference", authenticate, updatePreferences);
router.put("/update-profile", authenticate, updateProfile);
// router.put("/updateAvtar", authenticate, updateAvatar);
router.put("/update-password", authenticate, updatePassword);


module.exports = router;