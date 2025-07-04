const pool = require("../db");
const openpgp = require('openpgp');
const { generateKey, encrypt, decrypt, readKey, createMessage } = openpgp;





const getKeys = async (req, res) => {
    try {
      const  email  = req?.query.email || req.user.email;
      if (!email) {
        return res.status(400).json({ error: 'Email parameter is required' });
      }
  
      const result = await pool.query(
        `SELECT public_key, key_type 
         FROM user_public_keys 
         WHERE email = $1`,
        [email]
      );
  
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Public key not found for this email' });
      }
  
      res.json({
        email,
        publicKey: result.rows[0].public_key,
        keyType: result.rows[0].key_type
      });
  
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  };





  // Generate and store a new key pair
  const createUserKey = async (req, res) => {
    // const { email, name } = req.body;
    const userId = req.user.user_id; // From auth middleware
    const email =  req.user.email;
    const name = req.user.name || "user"
  
    try {
      // Generate new key pair (both public and private keys)
      const { publicKey, privateKey } = await generateKey({
        type: 'rsa', // Changed from 'ecc' to 'rsa'
        rsaBits: 2048, // Matches Python's key_length=2048
        userIDs: [{ name, email }],
        passphrase: '', // No passphrase to match Python's no_protection=True
        format: 'armored'
      });
  
      // Store both keys in database
      await pool.query(
        `INSERT INTO user_public_keys 
         (user_id, email, public_key, private_key, key_type, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'ecc', NOW(), NOW())`,
        [userId, email, publicKey, privateKey]
      );
  
      res.status(201).json({ 
        success: true,
        publicKey,
        // Optionally include privateKey in response if needed for immediate use
        // privateKey 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false,
        error: 'Failed to generate key',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  };

// Get existing key
const getUserKey = async (req, res) => {
  let emailToFetch;
  let isRequestingOwnKey = false;

  // Determine which email to fetch keys for
  if (req.query.email) {
    emailToFetch = req.query.email;
    isRequestingOwnKey = (req.query.email === req.user.email);
  } else {
    emailToFetch = req.user.email;
    isRequestingOwnKey = true;
  }

  try {
    // Only allow fetching private key if requesting own key
    const query = isRequestingOwnKey
      ? `SELECT public_key, private_key, email FROM user_public_keys 
         WHERE email = $1`
      : `SELECT public_key, email FROM user_public_keys 
         WHERE email = $1`;

    const result = await pool.query(query, [emailToFetch]);

    if (result.rows.length > 0) {
      const responseData = isRequestingOwnKey
        ? { 
            publicKey: result.rows[0].public_key, 
            privateKey: result.rows[0].private_key,
            email: result.rows[0].email
          }
        : {
            publicKey: result.rows[0].public_key,
            email: result.rows[0].email
          };
      return res.json(responseData);
    }
    
    res.status(404).json({ error: 'Key not found' });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
};
  
  // Helper function to validate keys (basic example)
  function isValidPublicKey(key, keyType) {
    if (keyType === 'openpgp') {
      return key.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----');
    }
    // Add other key type validations as needed
    return true;
  }


  const cacheKey = async (req, res) => {
    const { email, publicKey } = req.body;
    const userId = req.user.user_id; // From your auth middleware
  
    if (!email || !publicKey) {
      return res.status(400).json({ error: 'Email and publicKey are required' });
    }
  
    if (!publicKey.includes('BEGIN PGP PUBLIC KEY BLOCK') || 
        !publicKey.includes('END PGP PUBLIC KEY BLOCK')) {
      return res.status(400).json({ error: 'Invalid PGP public key format' });
    }
  
    try {
      // Check if key already exists
      const existingKey = await pool.query(
        'SELECT id FROM key_cache WHERE email = $1 AND user_id = $2',
        [email, userId]
      );
  
      if (existingKey.rows.length > 0) {
        // Update existing key
        await pool.query(
          `UPDATE key_cache 
           SET public_key = $1, updated_at = NOW()
           WHERE email = $2 AND user_id = $3`,
          [publicKey, email, userId]
        );
      } else {
        // Insert new key
        await pool.query(
          `INSERT INTO key_cache 
           (user_id, email, public_key, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())`,
          [userId, email, publicKey]
        );
      }
  
      res.status(200).json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to cache key' });
    }
  };
  
  // Get a cached key
 const getCachedKey = async (req, res) => {
    const { email } = req.query;
    const userId = req.user.user_id;
  
    if (!email) {
      return res.status(400).json({ error: 'Email parameter is required' });
    }
  
    try {
      const result = await pool.query(
        `SELECT public_key FROM key_cache 
         WHERE email = $1 AND user_id = $2`,
        [email, userId]
      );
  
      if (result.rows.length > 0) {
        return res.json({ publicKey: result.rows[0].public_key });
      }
      res.status(404).json({ error: 'Key not found in cache' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to retrieve key' });
    }
  }




  module.exports = {getKeys, createUserKey, getUserKey, cacheKey, getCachedKey};