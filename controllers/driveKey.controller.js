const { generateKeyPairSync } = require('crypto');
const pool = require('../db');

exports.getOrCreateDriveKey = async (req, res) => {
  const userId = req.user?.user_id;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Check for existing keys in the new table
    const { rows } = await pool.query(
      `SELECT drive_public_key, drive_private_key 
       FROM user_drive_keys WHERE user_id = $1`,
      [userId]
    );

    if (rows[0]?.drive_public_key && rows[0]?.drive_private_key) {
      return res.status(200).json({
        publicKey: rows[0].drive_public_key,
        privateKey: rows[0].drive_private_key 
      });
    }

    // Generate RSA key pair
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // Save to the new user_drive_keys table
    await pool.query(
      `INSERT INTO user_drive_keys 
       (user_id, drive_public_key, drive_private_key) 
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) 
       DO UPDATE SET
         drive_public_key = EXCLUDED.drive_public_key,
         drive_private_key = EXCLUDED.drive_private_key,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, publicKey, privateKey]
    );

    return res.status(201).json({
      publicKey,
      privateKey
    });

  } catch (err) {
    console.error('Key generation failed:', err);
    return res.status(500).json({ error: 'Failed to generate keys' });
  }
};