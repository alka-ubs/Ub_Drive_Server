const router = require("express").Router();
const { getKeys, createKeys, createUserKey, getUserKey, cacheKey, getCachedKey } = require("../controllers/keys.controller");
const authenticate = require("../middleware/auth.middleware");

// router.post("/user-keys", authenticate, getKeys);
router.post("/user-keys", authenticate, createUserKey);
router.get("/user-key", authenticate, getUserKey);
router.post("/cache-key", authenticate, cacheKey);
router.get("/cahche-key", authenticate, getCachedKey)




module.exports = router;