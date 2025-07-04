// routes/calendarRoutes.js
const express = require("express");
const router = express.Router();
const authenticate = require("../middleware/auth.middleware");
const { createOrganisation, getAllOrganisations, getOrganisationById, updateOrganisation, deleteOrganisation, updateOrganisationName, updateOrganisationIds, updateOrganisationKey, updateOrganisationLogo } = require("../controllers/organization.controller");

// CREATE
router.post("/add",authenticate, createOrganisation);

// READ
router.get("/get", getAllOrganisations);
router.get("/getById/:id",getOrganisationById);

// UPDATE
router.put("/updateName/:id",updateOrganisationName);
router.put("/updateIds/:id",updateOrganisationIds);
router.put("/updatekeys/:id",updateOrganisationKey);
router.put("/updateLogo/:id",updateOrganisationLogo);
router.put("/update/:id",updateOrganisation);

// DELETE (Soft delete)
router.delete("/delete/:id",authenticate, deleteOrganisation);

module.exports = router;