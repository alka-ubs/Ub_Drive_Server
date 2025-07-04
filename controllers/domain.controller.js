const pool = require('../db');

// Helper to generate dummy DNS records for a domain
function generateDNSRecords(domainName) {
  return {
    mx: `mx.${domainName}`,
    spf: `v=spf1 include:${domainName} ~all`,
    dkim: `default._domainkey.${domainName}`,
    dmarc: `v=DMARC1; p=none; rua=mailto:dmarc@${domainName}`
  };
}

// Create Domain
const createDomain = async (req, res) => {
  const userId = req.user?.user_id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const { domain_name } = req.body;
  if (!domain_name) return res.status(400).json({ error: "domain_name is required" });

  try {
    const dns = generateDNSRecords(domain_name);

    const result = await pool.query(
      `INSERT INTO domain (domain_name, user_id, is_verify, mx, spf, dkim, dmarc, is_deleted, created_at, updated_at)
       VALUES ($1, $2, FALSE, $3, $4, $5, $6, FALSE, NOW(), NOW()) RETURNING *`,
      [domain_name, userId, dns.mx, dns.spf, dns.dkim, dns.dmarc]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

// Get all domains for user
const getAllDomains = async (req, res) => {
  const userId = req.user?.user_id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await pool.query(`
      SELECT * FROM domain 
      WHERE user_id = $1 AND is_deleted = FALSE
      ORDER BY updated_at DESC
    `, [userId]);

    const domains = result.rows.map(row => ({
      id: row.id,
      domain_name: row.domain_name,
      is_verify: row.is_verify,
      mx: row.mx,
      spf: row.spf,
      dkim: row.dkim,
      dmarc: row.dmarc,
      is_deleted: row.is_deleted,
      created_at: row.created_at ? new Date(row.created_at).toISOString().split("T")[0] : null,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString().split("T")[0] : null
    }));

    res.json(domains);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};




// Get single domain by ID
const getDomainById = async (req, res) => {
  const userId = req.user?.user_id;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await pool.query(
      `SELECT * FROM domain
       WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [id, userId]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Domain not found" });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};


// Update domain
const updateDomain = async (req, res) => {
  const userId = req.user?.user_id;
  const { id } = req.params;
  const { domain_name, is_verify } = req.body;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Check if domain exists and belongs to user
    const existing = await pool.query(
      `SELECT * FROM domain
       WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [id, userId]
    );

    if (existing.rows.length === 0)
      return res.status(404).json({ error: "Domain not found" });

    const current = existing.rows[0];
    const updatedName = domain_name ?? current.domain_name;
    const updatedVerify = is_verify ?? current.is_verify;

    const dns = generateDNSRecords(updatedName);

    const result = await pool.query(
      `UPDATE domain SET 
         domain_name = $1,
         is_verify = $2,
         mx = $3,
         spf = $4,
         dkim = $5,
         dmarc = $6,
         updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [updatedName, updatedVerify, dns.mx, dns.spf, dns.dkim, dns.dmarc, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};


// Soft delete domain
const deleteDomain = async (req, res) => {
  const userId = req.user?.user_id;
  const { id } = req.params;

  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await pool.query(
      `UPDATE domain
       SET is_deleted = TRUE, deleted_at = NOW()
       WHERE id = $1
         AND user_id = $2
         AND is_deleted = FALSE
       RETURNING *`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Domain not found or already deleted" });
    }

    res.status(200).json({ message: "Domain deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};


module.exports = {
  createDomain,
  getAllDomains,
  getDomainById,
  updateDomain,
  deleteDomain
};