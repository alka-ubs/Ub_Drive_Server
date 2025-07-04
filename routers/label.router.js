// routes/calendarRoutes.js
const express = require("express");
const router = express.Router();
const authenticate = require("../middleware/auth.middleware");
const { createLabel, getLabels, getLabelById, updateLabel, deleteLabel } = require("../controllers/label.controller");


// CREATE
router.post("/add",authenticate, createLabel);
// READ
router.get("/get",authenticate, getLabels);
router.get("/getById/:id", authenticate,getLabelById);

// UPDATE
router.put("/update/:id", authenticate,updateLabel);

// DELETE (Soft delete)
router.delete("/delete/:id",authenticate, deleteLabel);



module.exports = router;