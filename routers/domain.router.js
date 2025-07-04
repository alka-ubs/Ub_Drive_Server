// routes/calendarRoutes.js
const express = require("express");
const router = express.Router();
const authenticate = require("../middleware/auth.middleware");
const { createDomain, getAllDomains, getDomainById, updateDomain, deleteDomain } = require("../controllers/domain.controller");


// CREATE
router.post("/add",authenticate, createDomain);
// READ
router.get("/get",authenticate, getAllDomains);
router.get("/getById/:id", authenticate,getDomainById);

// UPDATE
router.put("/update/:id", authenticate,updateDomain);

// DELETE (Soft delete)
router.delete("/delete/:id",authenticate, deleteDomain);



module.exports = router;