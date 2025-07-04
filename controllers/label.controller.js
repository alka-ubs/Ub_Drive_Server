const pool = require("../db");

// Create Label
exports.createLabel = async (req, res) => {
  const userId = req.user.user_id;
  const { name, color } = req.body;

  if (!name || !color) {
    return res.status(400).json({ error: 'Name and color are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO labels (user_id, name, type, color)
       VALUES ($1, $2, 'custom', $3)
       RETURNING *`,
      [userId, name, color]
    );
    // res.status(201).json(result.rows[0]);
     res.json({ message: 'Label added' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create label' });
  }
};

// Get All Labels
exports.getLabels = async (req, res) => {
  const userId = req.user.user_id;

  try {
    const result = await pool.query(
      `SELECT * FROM labels WHERE user_id = $1 ORDER BY sort_order ASC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch labels' });
  }
};

// Get Label By ID
exports.getLabelById = async (req, res) => {
  const userId = req.user.user_id;
  const labelId = req.params.id;

  try {
    const result = await pool.query(
      `SELECT * FROM labels WHERE label_id = $1 AND user_id = $2`,
      [labelId, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Label not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch label' });
  }
};

// Update Label
exports.updateLabel = async (req, res) => {
  const userId = req.user.user_id;
  const labelId = req.params.id;
  const { name, color } = req.body;

  if (name === undefined && color === undefined) {
    return res.status(400).json({ error: 'At least one of name or color is required' });
  }

  try {
    const fields = [];
    const values = [];
    let index = 1;

    if (name !== undefined) {
      fields.push(`name = $${index++}`);
      values.push(name);
    }

    if (color !== undefined) {
      fields.push(`color = $${index++}`);
      values.push(color);
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);

    const query = `
      UPDATE labels
      SET ${fields.join(', ')}
      WHERE label_id = $${index++} AND user_id = $${index}
      RETURNING *;
    `;

    values.push(labelId, userId);

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Label not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update label' });
  }
};

// Delete Label
exports.deleteLabel = async (req, res) => {
  const userId = req.user.user_id;
  const labelId = req.params.id;

  try {
    const result = await pool.query(
      `DELETE FROM labels WHERE label_id = $1 AND user_id = $2 RETURNING *`,
      [labelId, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Label not found' });
    res.json({ message: 'Label deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete label' });
  }
};
