const pool = require("../db");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const bcrypt = require('bcryptjs');

const createUser = async (req, res) => {
  const { email, password, username, recovery_email, first_name, last_name, mobile } = req.body;
  const is_active = true;

  const client = await pool.connect();

  try {
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    await client.query('BEGIN');

    const userResult = await client.query(
      `INSERT INTO users 
      (email, password, username, recovery_email, is_active, first_name, last_name, mobile) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
      RETURNING *`,
      [email, hashedPassword, username, recovery_email, is_active, first_name, last_name, mobile]
    );

    const user = userResult.rows[0];

    await client.query(`
      INSERT INTO folders (user_id, name, type, sort_order)
      VALUES 
        ($1, 'Inbox', 'inbox', 1),
        ($1, 'Sent', 'sent', 2),
        ($1, 'Drafts', 'drafts', 3),
        ($1, 'Trash', 'trash', 4),
        ($1, 'Spam', 'spam', 5),
        ($1, 'Archive', 'archive', 6)
    `, [user.id]);

    await client.query('COMMIT');

    // ✅ Auto-login logic after successful signup
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.createdAt = new Date();
    req.session.userAgent = req.headers['user-agent'] || 'unknown';
    req.session.ip = req.ip;

    const token = jwt.sign(
      { email: user.email, user_id: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    req.session.save((err) => {
      if (err) {
        console.error("⚠️ Auto-login failed after signup:", err);
        return res.status(200).json({
          message: "Signup successful, but login session failed",
          token,
          userId: user.id,
          email: user.email
        });
      }

      return res.status(200).json({
        message: "Signup & login successful",
        token,
        session: {
          sessionId: req.sessionID,
          createdAt: req.session.createdAt,
          ip: req.session.ip,
          userAgent: req.session.userAgent
        }
      });
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('User creation failed:', err);

    if (err.code === '23505') {
      res.status(400).send({
        error: 'Registration failed',
        details: 'Email or username already exists'
      });
    } else {
      res.status(500).send({
        error: 'User creation failed',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  } finally {
    client.release();
  }
};




const loginUser = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(403).json({ message: "Unauthenticated User" });
  }

  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = result.rows[0];

    // ✅ Step: Compare plaintext password with hashed one
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // ✅ Set session data
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.createdAt = new Date();
    req.session.userAgent = req.headers['user-agent'] || 'unknown';
    req.session.ip = req.ip;

    // ✅ Generate JWT token
    const token = jwt.sign(
      { email: user.email, user_id: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    req.session.save((err) => {
      if (err) {
        console.error("❌ Failed to save session:", err);
        return res.status(500).json({ error: "Failed to initialize session" });
      }

      console.log("✅ Session saved:", req.session);
      console.log("✅ Session ID:", req.sessionID);

      return res.status(200).json({
        message: "Login successful",
        token,
        session: {
          sessionId: req.sessionID,
          createdAt: req.session.createdAt,
          ip: req.session.ip,
          userAgent: req.session.userAgent
        }
      });
    });

  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed", details: err.message });
  }
};



const updatePassword = async (req, res) => {
  const userId = req.user.user_id;
  const { currentPassword, newPassword } = req.body;

  // Validate input
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new passwords are required.' });
  }

  try {
    // Step 1: Get current hashed password from DB
    const userQuery = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);

    if (userQuery.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const storedHashedPassword = userQuery.rows[0].password;

    // Step 2: Compare currentPassword with stored hash
    const isMatch = await bcrypt.compare(currentPassword, storedHashedPassword);
    if (!isMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Step 3: Hash the new password
    const saltRounds = 10;
    const newHashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Step 4: Update the password in the DB
    const updateQuery = `
      UPDATE users
      SET password = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING id, email, username
    `;

    const { rows } = await pool.query(updateQuery, [newHashedPassword, userId]);

    res.json({ message: 'Password updated successfully', user: rows[0] });
  } catch (error) {
    console.error('Error updating password:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};




const logoutUser = async  (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).send("Logout failed");
    res.clearCookie('connect.sid');
    res.send({ success: true });
    
  });
}

  

  const getProfile = async (req, res)=>{
    let userId = req.user.user_id;
    try{
        const userQuery = await pool.query(
            `SELECT 
              email, 
              username, 
              is_active, 
              is_verified, 
              is_admin, 
              mailbox_quota, 
              used_quota, 
              two_factor_enabled, 
              failed_login_attempts, 
              last_login, 
              created_at, 
              updated_at, 
              deleted_at, 
              first_name, 
              last_name, 
              mobile,
              preferences,
              language,
              avatar,
              timezone,
              avatar,
              RecoveryEmail
            FROM users 
            WHERE id = $1`,
            [userId]
          );
      
          if (userQuery.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
          }
      
          const user = userQuery.rows[0];

          let userBody ={
            id: userId,
            email: user.email,
            username: user.username,
            is_active: user.is_active,
            is_verified: user.is_verified,
            is_admin: user.is_admin,
            mailbox_quota: user.mailbox_quota,
            used_quota: user.used_quota,
            two_factor_enabled: user.two_factor_enabled,
            failed_login_attempts: user.failed_login_attempts,
            last_login: user.last_login,
            created_at: user.created_at,
            updated_at: user.updated_at,
            deleted_at: user.deleted_at,
            first_name: user.first_name,
            last_name: user.last_name,
            mobile: user.mobile,
            preferences: user.preferences,
            language: user.language,
            avatar: user.avatar,
            timezone: user.timezone,
            avatar: user.avatar,
            RecoveryEmail: user.RecoveryEmail
          };

          res.status(200).json(userBody)
    }catch(err){
      console.log(err);
    }
  };

  


  const addUserToBlock = async (req, res) => {
    try {
        const { emailToBlock } = req.body;
        const userId = req.user.user_id;

        // Validate input
        if (!emailToBlock) {
            return res.status(400).json({ error: "Email to block is required." });
        }

        if (req.user.email == emailToBlock) {
            return res.status(400).json({ error: "You cannot block your own email." });
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(emailToBlock)) {
            return res.status(400).json({ error: "Invalid email format." });
        }

        // First verify user exists
        const userCheck = await pool.query(
            "SELECT id FROM users WHERE id = $1",
            [userId]
        );

        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        // Check if email is already blocked
        const existingBlock = await pool.query(
            `SELECT blocked_emails FROM users 
             WHERE id = $1 AND $2 = ANY(blocked_emails) LIMIT 1`,
            [userId, emailToBlock]
        );

        if (existingBlock.rows.length > 0) {
            return res.status(409).json({ error: "Email already blocked" });
        }

        // Update blocked_emails array in users table
        const result = await pool.query(
            `UPDATE users 
             SET blocked_emails = array_append(
                 COALESCE(blocked_emails, '{}'::text[]), 
                 $1
             )
             WHERE id = $2
             RETURNING blocked_emails`,
            [emailToBlock, userId]
        );

        // Handle case where UPDATE affected 0 rows (shouldn't happen after user check)
        if (result.rows.length === 0) {
            throw new Error("Failed to update blocked emails");
        }

        res.status(200).json({ 
            success: true, 
            blockedEmails: result.rows[0].blocked_emails 
        });

    } catch (err) {
        console.error("Error blocking email:", err);
        
        // Handle specific database errors
        if (err.message.includes('column "blocked_emails" does not exist')) {
            return res.status(500).json({ 
                error: "Server configuration error",
                details: "Blocked emails feature not properly configured"
            });
        }

        res.status(500).json({ 
            error: "Internal server error",
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
};

const addUserToSpam = async (req, res) => {
  const client = await pool.connect(); // Get a client for transaction

  try {
    const { emailToSpam } = req.body;
    const userId = req.user.user_id;

    // Validate input
    if (!emailToSpam) {
      return res.status(400).json({ error: "Email to mark as spam is required." });
    }

    if (req.user.email == emailToSpam) {
      return res.status(400).json({ error: "You cannot mark your own email as spam." });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailToSpam)) {
      return res.status(400).json({ error: "Invalid email format." });
    }

    await client.query('BEGIN'); // Start transaction

    try {
      // 1. Verify user exists
      const userCheck = await client.query(
        "SELECT id FROM users WHERE id = $1",
        [userId]
      );

      if (userCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "User not found" });
      }

      // 2. Check if email is already marked as spam
      const existingSpam = await client.query(
        `SELECT spammed_emails FROM users 
         WHERE id = $1 AND $2 = ANY(spammed_emails) LIMIT 1`,
        [userId, emailToSpam]
      );

      if (existingSpam.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: "Email already marked as spam" });
      }

      // 3. Update spammed_emails array in users table
      const result = await client.query(
        `UPDATE users 
         SET spammed_emails = array_append(
             COALESCE(spammed_emails, '{}'::text[]), 
             $1
         )
         WHERE id = $2
         RETURNING spammed_emails`,
        [emailToSpam, userId]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error("Failed to update spammed emails");
      }

      // 4. Get the Spam folder ID for this user
      const folderResult = await client.query(
        `SELECT folder_id FROM folders 
         WHERE user_id = $1 AND type = 'spam'`,
        [userId]
      );

      if (folderResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: "Spam folder not found" });
      }

      const spamFolderId = folderResult.rows[0].folder_id;

      // 5. Update all existing emails from this sender to Spam folder
      const updateMailsResult = await client.query(
        `UPDATE mailboxes
         SET folder = 'Spam', folder_id = $1
         WHERE user_id = $2 AND from_email = $3
         RETURNING id`,
        [spamFolderId, userId, emailToSpam]
      );

      await client.query('COMMIT'); // Commit transaction

      res.status(200).json({ 
        success: true, 
        spammedEmails: result.rows[0].spammed_emails,
        updatedEmailsCount: updateMailsResult.rowCount,
        spamFolderId: spamFolderId
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error("Error marking email as spam:", err);
    
    // Handle specific database errors
    if (err.message.includes('column "spammed_emails" does not exist')) {
      return res.status(500).json({ 
        error: "Server configuration error",
        details: "Spam emails feature not properly configured"
      });
    }

    if (err.message.includes('relation "mailboxes" does not exist')) {
      return res.status(500).json({ 
        error: "Server configuration error",
        details: "Mailboxes table not found"
      });
    }

    res.status(500).json({ 
      error: "Internal server error",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    client.release();
  }
};


const checkSession = (req, res) => {
  console.log("Session ID: checking while /users/session", req.sessionID);
  console.log("Session Object:", req.session);
  if ( req.session && req.session?.userId) {
    return res.json({ authenticated: true, email: req.session.email, userId: req.session.userId });
  }
  res.status(401).json({ authenticated: false });
  
};


const ALLOWED_FIELDS = [
  'username',
  'recovery_email',
  'is_active',
  'is_verified',
  'is_admin',
  'mailbox_quota',
  'used_quota',
  'two_factor_enabled',
  'failed_login_attempts',
  'last_login',
  'first_name',
  'last_name',
  'mobile',
  'blocked_emails',
  'spammed_emails',
  'language',
  'timezone',
  'RecoveryEmail',
];


const updateProfile =  async (req, res) => {
  const  userId  = req.user.user_id;
  const { updates } = req.body;

  try {
    // Filter out any fields that shouldn't be updated
    const filteredUpdates = {};
    for (const key in updates) {
      if (ALLOWED_FIELDS.includes(key) && key !== 'preferences') {
        filteredUpdates[key] = updates[key];
      }
    }

    // If no valid fields to update
    if (Object.keys(filteredUpdates).length === 0) {
      return res.status(400).json({ 
        error: 'No valid fields provided for update' 
      });
    }

    // Build the SET clause for the SQL query
    const setClause = Object.keys(filteredUpdates)
      .map((key, index) => `${key} = $${index + 1}`)
      .join(', ');

    const values = Object.values(filteredUpdates);
    values.push(userId); // Add userId as the last parameter

    const queryText = `
      UPDATE users 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $${values.length} 
      RETURNING *
    `;

    const { rows } = await pool.query(queryText, values);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: rows[0] });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

const updateAvatar = async (req, res) => {
  let { encryptedImage } = req.body;

  const userId = req.user.user_id;

  try {
    // 1️⃣ Generate a short unique filename
    // const fileExt = path.extname(req.file.originalname); // e.g. .png, .jpg
    // const shortName = `avatar_${userId}_${Date.now()}${fileExt}`;

    // // 2️⃣ Save file to public/avatars
    // const avatarsDir = path.join(__dirname, '../public/avatars');
    // await fs.mkdir(avatarsDir, { recursive: true }); // ensure dir exists

    // const filePath = path.join(avatarsDir, shortName);
    // await fs.writeFile(filePath, req.file.buffer);

    // // 3️⃣ Generate URL (assuming your static folder is served at /public)
    // const avatarUrl = `/public/avatars/${shortName}`;

    // 4️⃣ Save URL in DB
    const result = await pool.query(
      `UPDATE users SET avatar = $1, updated_at = NOW() WHERE id = $2 RETURNING avatar, updated_at`,
      [encryptedImage, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    return res.status(200).json({
      message: 'Avatar updated successfully!',
      updated_at: result.rows[0].updated_at,
    });
  } catch (err) {
    console.error('Error updating avatar:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};


const updatePreferences =  async (req, res) => {
  const userId = req.user.user_id; // from auth middleware
  const newPrefs = req.body;

  if (!newPrefs || typeof newPrefs !== 'object') {
    return res.status(400).json({ error: 'Invalid preferences payload.' });
  }

  try {
    // Fetch current preferences
    const { rows } = await pool.query(`SELECT preferences FROM users WHERE id = $1`, [userId]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const existingPrefs = rows[0].preferences?.[0] || {};
    const updatedPrefs = { ...existingPrefs, ...newPrefs };

    // Save merged settings as a single-element array
    await pool.query(
      `UPDATE users SET preferences = $1::jsonb WHERE id = $2`,
      [JSON.stringify(updatedPrefs), userId]
    );

    return res.json({ message: 'Preferences updated', preferences: updatedPrefs });
  } catch (err) {
    console.error('Error updating preferences:', err);
    res.status(500).json({ error: 'Server error' });
  }
}


const verifyTokenExpire = (req, res) => {
  const token = req.body.token || req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(400).json({ message: "Token not provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return res.status(200).json({ valid: true, expired: false, decoded });
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(200).json({ valid: false, expired: true, message: "Token expired" });
    }
    return res.status(200).json({ valid: false, expired: false, message: "Invalid token" });
  }
};

module.exports = {
  createUser, 
  loginUser, 
  getProfile, 
  addUserToBlock, 
  addUserToSpam, 
  logoutUser, 
  checkSession, 
  updatePreferences,
  updateProfile,
  updatePassword,
  updateAvatar,
  verifyTokenExpire
}