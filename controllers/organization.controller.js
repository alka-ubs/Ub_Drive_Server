const pool = require("../db");

// Get all organisations for the authenticated user (exclude soft deleted)
const getAllOrganisations = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM organisation WHERE is_deleted = FALSE"
    );

    // Convert logo buffers to base64 strings
    const organisations = result.rows.map(org => ({
      ...org,
      logo: org.logo ? org.logo.toString("base64") : null,
    }));

    res.json(organisations);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};


// Get a specific organisation by ID for the authenticated user (exclude soft deleted)
const getOrganisationById = async (req, res) => {
  const userId = req.user?.user_id;
  if (!userId) return res.status(401).send("Unauthorized");

  const { id } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM organisation WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE",
      [id, userId]
    );

    if (result.rows.length === 0)
      return res.status(404).send("Organisation not found");

    const organisation = result.rows[0];

    res.json({
      ...organisation,
      logo: organisation.logo ? organisation.logo.toString("base64") : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};

// Create a new organisation
const createOrganisation = async (req, res) => {
  const userId = req.user?.user_id;
  if (!userId) return res.status(401).send("Unauthorized");

  const { name, ids, logo, key } = req.body;

  try {
    const result = await pool.query(
      "INSERT INTO organisation (name, ids, logo, key, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [name, ids, logo || null, key, userId]
    );

    res.status(200).json({ message: "Organisation added", id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};


// Update an existing organisation (partial update supported)
const updateOrganisation = async (req, res) => {
  const userId = req.user?.user_id;
  if (!userId) return res.status(401).send("Unauthorized");

  const { id } = req.params;
  const { name, ids, logo, key } = req.body;

  try {
    // Fetch existing organisation
    const existing = await pool.query(
      "SELECT * FROM organisation WHERE id=$1 AND user_id=$2 AND is_deleted = FALSE",
      [id, userId]
    );

    if (existing.rows.length === 0)
      return res.status(404).send("Organisation not found");

    const org = existing.rows[0];

    // Prepare updated values, use existing if undefined
    const updatedName = name !== undefined ? name : org.name;
    const updatedIds = ids !== undefined ? ids : org.ids;
    const updatedLogo = logo !== undefined ? Buffer.from(logo, "base64") : org.logo;
    const updatedKey = key !== undefined ? key : org.key;

    // Update organisation
    const result = await pool.query(
      "UPDATE organisation SET name=$1, ids=$2, logo=$3, key=$4, updated_at = NOW() WHERE id=$5 AND user_id=$6 RETURNING *",
      [updatedName, updatedIds, updatedLogo, updatedKey, id, userId]
    );

    const updatedOrg = result.rows[0];
    res.json({
      ...updatedOrg,
      logo: updatedOrg.logo ? updatedOrg.logo.toString("base64") : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};


// PATCH /organisation/:id/name
const updateOrganisationName = async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).send("Missing name");

  try {
    const result = await pool.query(
      "UPDATE organisation SET name=$1, updated_at = NOW() WHERE id=$2 AND is_deleted = FALSE RETURNING *",
      [name, id]
    );
    if (result.rows.length === 0) return res.status(404).send("Not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};



// PATCH /organisation/:id/logo
const updateOrganisationLogo = async (req, res) => {
  const { id } = req.params;
  const { logo } = req.body;

  if (!logo) return res.status(400).send("Missing logo");

  try {
    const result = await pool.query(
      "UPDATE organisation SET logo = $1, updated_at = NOW() WHERE id = $2 AND is_deleted = FALSE RETURNING *",
      [logo, id]
    );
    if (result.rows.length === 0) return res.status(404).send("Not found");

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};



// PATCH /organisation/:id/ids
const updateOrganisationIds = async (req, res) => {
  const { id } = req.params;
  const { ids } = req.body;
  if (!ids) return res.status(400).send("Missing ids");

  const idsAsString = Array.isArray(ids) ? ids.join(',') : ids;

  try {
    const result = await pool.query(
      "UPDATE organisation SET ids=$1, updated_at = NOW() WHERE id=$2 AND is_deleted = FALSE RETURNING *",
      [idsAsString, id]
    );
    if (result.rows.length === 0) return res.status(404).send("Not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};


// PATCH /organisation/:id/key
const updateOrganisationKey = async (req, res) => {
  const { id } = req.params;

  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let newKey = "";
  for (let i = 0; i < 50; i++) {
    newKey += charset.charAt(Math.floor(Math.random() * charset.length));
  }

  try {
    const result = await pool.query(
      `UPDATE organisation
         SET key = $1,
             updated_at = NOW()
       WHERE id = $2
         AND is_deleted = FALSE
       RETURNING *`,
      [newKey, id]
    );

    if (result.rows.length === 0)
      return res.status(404).send("Organisation not found");

    res.json({ message: "Key updated", key: newKey });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};


// Soft delete an organisation by setting is_deleted = TRUE
const deleteOrganisation = async (req, res) => {
  const userId = req.user?.user_id;
  if (!userId) return res.status(401).send("Unauthorized");

  const { id } = req.params;
  try {
    const result = await pool.query(
      "UPDATE organisation SET is_deleted = TRUE, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE RETURNING *",
      [id, userId]
    );

    if (result.rows.length === 0)
      return res.status(404).send("Organisation not found or already deleted");

   res.status(200).json({ message: "Organisation deleted" });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
};

module.exports = {
  getAllOrganisations,
  getOrganisationById,
  createOrganisation,
  updateOrganisation,
  deleteOrganisation,
  updateOrganisationName,
  updateOrganisationKey,
  updateOrganisationLogo,
  updateOrganisationIds
};
