const pool = require("../db");
const nodemailer = require("nodemailer");
const { v4: uuidv4 } = require("uuid");
const threadId = uuidv4();
const { groupBy } = require("pg");

const getEmails = async (req, res) => {
  try {
    const userEmail = req.user.email;
    const folderParam = req.query.folder || null;
    const starred = req.query.starred;
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 20;
    const searchTerm = req.query.search || '';
    const returnThreads = req.query.threads !== 'false'; // Default to true unless explicitly false

    if (page < 1 || perPage < 1 || isNaN(page) || isNaN(perPage)) {
      return res.status(400).json({
        error: "Invalid pagination parameters",
        details: {
          page: "Must be a positive integer",
          perPage: "Must be a positive integer"
        }
      });
    }

    if (!userEmail) {
      return res.status(400).json({ error: "Missing email in headers" });
    }

    const userResult = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [userEmail]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const userId = userResult.rows[0].id;

    let baseConditions = `WHERE m.user_id = $1 AND $2 = ANY(ARRAY[m.from_email, m.to_email])`;
    let params = [userId, userEmail];
    let paramCounter = 3;

    if (folderParam) {
      const folderNames = folderParam.split(',').map(f => f.trim());

      if (folderNames.length > 1) {
        baseConditions += ` AND m.folder_id IN (
          SELECT folder_id FROM folders 
          WHERE user_id = $1 AND name = ANY($${paramCounter}::text[])
        )`;
        params.push(folderNames);
      } else {
        baseConditions += ` AND m.folder_id = (
          SELECT folder_id FROM folders 
          WHERE user_id = $1 AND name = $${paramCounter}
        )`;
        params.push(folderNames[0]);
      }
      paramCounter++;
    } else {
      baseConditions += ` AND m.folder_id IN (
        SELECT folder_id FROM folders 
        WHERE user_id = $1 AND type IN ('inbox')
      )`;
    }

    if (starred === 'true') {
      baseConditions += ` AND m.is_starred = true`;
    } else if (starred === 'false') {
      baseConditions += ` AND m.is_starred = false`;
    }

    if (searchTerm) {
      baseConditions += ` AND (
        m.subject ILIKE '%' || $${paramCounter} || '%'
        OR m.from_email ILIKE '%' || $${paramCounter} || '%'
        OR m.to_email ILIKE '%' || $${paramCounter} || '%'
        OR m.body ILIKE '%' || $${paramCounter} || '%'
        OR m.plain_text ILIKE '%' || $${paramCounter} || '%'
      )`;
      params.push(searchTerm);
      paramCounter++;
    }

    const countQuery = returnThreads 
      ? `SELECT COUNT(DISTINCT m.thread_id) FROM mailboxes m ${baseConditions}`
      : `SELECT COUNT(m.id) FROM mailboxes m ${baseConditions}`;
    
    const countResult = await pool.query(countQuery, params);
    const totalCount = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(totalCount / perPage);

    let emailsQuery;
    if (returnThreads) {
      emailsQuery = `
        SELECT 
          sub.*,
          f.folder_id,
          f.name as folder_name,
          f.type as folder_type,
          f.color as folder_color,
          f.icon as folder_icon
        FROM (
          SELECT DISTINCT ON (m.thread_id)
            m.id, m.subject, m.body, m.from_email, m.to_email, 
            m.created_at, m.thread_id, m.is_read, m.folder_id, 
            m.message_id, m.is_draft, m.message_type, m.is_starred, 
            m.plain_text, m.headers, m.encryption_metadata, 
            m.sender_public_key, m.key_fingerprints, m.attachments
          FROM mailboxes m
          ${baseConditions}
          ORDER BY m.thread_id, m.created_at DESC
        ) sub
        LEFT JOIN folders f ON sub.folder_id = f.folder_id
        ORDER BY sub.created_at DESC
        LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
      `;
    } else {
      emailsQuery = `
        SELECT 
          m.*,
          f.folder_id,
          f.name as folder_name,
          f.type as folder_type,
          f.color as folder_color,
          f.icon as folder_icon
        FROM mailboxes m
        LEFT JOIN folders f ON m.folder_id = f.folder_id
        ${baseConditions}
        ORDER BY m.created_at DESC
        LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
      `;
    }

    const offset = (page - 1) * perPage;
    params.push(perPage, offset);

    const { rows } = await pool.query(emailsQuery, params);

    const emails = rows.map(row => ({
      id: row.id,
      subject: row.subject,
      body: row.body,
      plain_text: row.plain_text,
      from_email: row.from_email,
      to_email: row.to_email,
      created_at: row.created_at,
      thread_id: row.thread_id,
      is_read: row.is_read,
      message_id: row.message_id,
      is_draft: row.is_draft,
      message_type: row.message_type,
      is_starred: row.is_starred,
      headers: row.headers,
      encryption_metadata: row.encryption_metadata,
      sender_public_key: row.sender_public_key,
      key_fingerprints: row.key_fingerprints,
      attachments: row.attachments || [],
      folder_info: {
        folder_id: row.folder_id,
        name: row.folder_name,
        type: row.folder_type,
        color: row.folder_color,
        icon: row.folder_icon
      },
      // Clean up response
      folder_id: undefined,
      folder_name: undefined,
      folder_type: undefined,
      folder_color: undefined,
      folder_icon: undefined
    })); 

    res.status(200).json({
      emails,
      pagination: {
        currentPage: page,
        perPage: perPage,
        totalCount: totalCount,
        totalPages: totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      },
      search: {
        term: searchTerm,
        resultsCount: emails.length
      },
      filters: {
        starred: starred || 'all',
        folders: folderParam ? folderParam.split(',') : ['inbox'],
        threads: returnThreads
      }
    });

  } catch (error) {
    console.error("Error fetching emails:", error);
    res.status(500).json({
      error: "Internal server error",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};





const getEmailCounts = async (req, res) => {
  const client = await pool.connect();
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] 📥 [getEmailCounts] API hit for user: ${req.user?.user_id}`);

  try {
    const userId = req.user.user_id;

    if (!userId) {
      console.warn(`[${timestamp}] ❌ Unauthorized request - Missing user ID`);
      return res.status(401).json({ 
        error: "Unauthorized",
        details: "User ID not found in authentication token"
      });
    }

    // Initialize response structure
    const countsResponse = {
      folders: {},
      starred: 0,
      unread: 0,
      total: 0,
      thread_counts: {
        total: 0,
        starred: 0,
        unread: 0
      }
    };

    // Step 1: Fetch folders (without transaction)
    console.log(`[${timestamp}] 📂 Fetching folders for user ${userId}`);
    const foldersQuery = `
      SELECT folder_id, name, type 
      FROM folders 
      WHERE user_id = $1
      ORDER BY type, name
    `;
    const foldersResult = await client.query(foldersQuery, [userId]);
    const folders = foldersResult.rows;

    if (folders.length === 0) {
      console.warn(`[${timestamp}] ⚠️ No folders found for user ${userId}`);
      return res.status(200).json({
        counts: countsResponse,
        message: "No folders found for this user"
      });
    }

    // Step 2: Count emails per folder (individual queries)
    console.log(`[${timestamp}] 📊 Counting emails in ${folders.length} folders...`);
    for (const folder of folders) {
      try {
        const countQuery = `
          SELECT 
            COUNT(*) AS total_count,
            COUNT(CASE WHEN is_starred THEN 1 END) AS starred_count,
            COUNT(CASE WHEN is_read THEN 1 END) AS read_count,
            COUNT(CASE WHEN NOT is_read THEN 1 END) AS unread_count
          FROM mailboxes
          WHERE user_id = $1 AND folder_id = $2
        `;
        
        const countResult = await client.query(countQuery, [userId, folder.folder_id]);
        const result = countResult.rows[0] || {};

        countsResponse.folders[folder.folder_id] = {
          name: folder.name,
          type: folder.type,
          total: parseInt(result.total_count || 0),
          starred: parseInt(result.starred_count || 0),
          read: parseInt(result.read_count || 0),
          unread: parseInt(result.unread_count || 0)
        };

        countsResponse.starred += countsResponse.folders[folder.folder_id].starred;
        countsResponse.unread += countsResponse.folders[folder.folder_id].unread;
        countsResponse.total += countsResponse.folders[folder.folder_id].total;
      } catch (err) {
        console.error(`[${timestamp}] ❌ Error counting folder ${folder.folder_id}:`, err);
        countsResponse.folders[folder.folder_id] = {
          name: folder.name,
          type: folder.type,
          total: 0,
          starred: 0,
          unread: 0,
          read: 0
        };
      }
    }

    // Step 3: Thread-based counts
    console.log(`[${timestamp}] 📬 Counting threads...`);
    try {
      const threadCountQuery = `
        SELECT 
          COUNT(DISTINCT thread_id) as total_threads,
          COUNT(DISTINCT CASE WHEN is_starred THEN thread_id END) as starred_threads,
          COUNT(DISTINCT CASE WHEN NOT is_read THEN thread_id END) as unread_threads
        FROM mailboxes
        WHERE user_id = $1
      `;
      const threadCountResult = await client.query(threadCountQuery, [userId]);
      
      countsResponse.thread_counts = {
        total: parseInt(threadCountResult.rows[0]?.total_threads || 0),
        starred: parseInt(threadCountResult.rows[0]?.starred_threads || 0),
        unread: parseInt(threadCountResult.rows[0]?.unread_threads || 0)
      };
    } catch (err) {
      console.error(`[${timestamp}] ❌ Error counting threads:`, err);
    }

    // Step 4: Final response
    const response = {
      counts: countsResponse,
      metadata: {
        user_id: userId,
        folder_count: folders.length,
        timestamp
      }
    };

    console.log(`[${timestamp}] ✅ Email count response prepared`, {
      summary: {
        folders: folders.length,
        total: response.counts.total,
        unread: response.counts.unread,
        starred: response.counts.starred,
        threads: response.counts.thread_counts.total
      }
    });

    return res.status(200).json(response);

  } catch (error) {
    console.error(`[${timestamp}] ❌ Fatal error in getEmailCounts:`, error);
    return res.status(500).json({ 
      error: "Internal server error",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
    console.log(`[${timestamp}] 🔚 Connection released for user ${req.user?.user_id}`);
  }
};




const getStarredEmails = async (req, res) => {
  try {
    const userId = req.user.user_id;
    const userEmail = req.user.email;
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 20;
    const searchTerm = req.query.search || '';

    // Validate pagination parameters
    if (page < 1 || perPage < 1 || isNaN(page) || isNaN(perPage)) {
      return res.status(400).json({ 
        error: "Invalid pagination parameters",
        details: {
          page: "Must be a positive integer",
          perPage: "Must be a positive integer"
        }
      });
    }

    if (!userId || !userEmail) {
      return res.status(401).json({ 
        error: "Unauthorized",
        details: "User credentials missing"
      });
    }

    // Build the base query conditions
    let baseConditions = `
      FROM mailboxes m
      JOIN folders f ON m.folder_id = f.folder_id
      WHERE m.user_id = $1
      AND m.is_starred = true
      AND f.user_id = $1
      AND f.type IN ('inbox', 'sent')
      AND ($2 = m.from_email OR $2 = ANY(m.to_email) OR $2 = ANY(m.cc) OR $2 = ANY(m.bcc))
    `;
    let params = [userId, userEmail];
    let paramCounter = 3;

    // Handle search condition
    if (searchTerm) {
      baseConditions += ` AND (
        m.subject ILIKE '%' || $${paramCounter} || '%'
        OR m.from_email ILIKE '%' || $${paramCounter} || '%'
        OR m.to_email ILIKE '%' || $${paramCounter} || '%'
        OR m.body ILIKE '%' || $${paramCounter} || '%'
        OR m.plain_text ILIKE '%' || $${paramCounter} || '%'
      )`;
      params.push(searchTerm);
      paramCounter++;
    }

    // First get total count
    const countQuery = `
      SELECT COUNT(DISTINCT m.thread_id) 
      ${baseConditions}
    `;
    
    const countResult = await pool.query(countQuery, params);
    const totalCount = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(totalCount / perPage);

    // Then fetch paginated results
    const emailsQuery = `
      SELECT DISTINCT ON (m.thread_id)
        m.id, m.subject, m.body, m.from_email, m.to_email, 
        m.created_at, m.thread_id, m.is_read, m.folder_id, 
        m.message_id, m.is_draft, m.message_type, m.is_starred,
        m.cc, m.bcc,
        f.folder_id as folder_id,
        f.name as folder_name,
        f.type as folder_type,
        f.color as folder_color,
        f.icon as folder_icon
      ${baseConditions}
      ORDER BY m.thread_id, m.created_at DESC
      LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
    `;
    
    const offset = (page - 1) * perPage;
    params.push(perPage, offset);
    
    const { rows } = await pool.query(emailsQuery, params);

    // Transform the response
    const emails = rows.map(row => ({
      id: row.id,
      subject: row.subject,
      body: row.body,
      from_email: row.from_email,
      to_email: row.to_email,
      cc: row.cc,
      bcc: row.bcc,
      created_at: row.created_at,
      thread_id: row.thread_id,
      is_read: row.is_read,
      message_id: row.message_id,
      is_draft: row.is_draft,
      message_type: row.message_type,
      is_starred: row.is_starred,
      folder_info: {
        folder_id: row.folder_id,
        name: row.folder_name,
        type: row.folder_type,
        color: row.folder_color,
        icon: row.folder_icon
      }
    }));

    res.status(200).json({ 
      emails,
      pagination: {
        currentPage: page,
        perPage: perPage,
        totalCount: totalCount,
        totalPages: totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      },
      search: {
        term: searchTerm,
        resultsCount: rows.length
      }
    });

  } catch (error) {
    console.error("Error fetching starred emails:", error);
    res.status(500).json({ 
      error: "Internal server error",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};
  
  
  
  
const getEmailsByThreadId = async (req, res) => {
  try {
    const userEmail = req.user.email;
    const { thread_id } = req.params;
    const { folder } = req.query; // Get folder from query params

    if (!userEmail) {
      return res.status(400).json({ error: "Missing email in headers" });
    }

    if (!thread_id) {
      return res.status(400).json({ error: "Missing thread_id parameter" });
    }

    // Get user ID
    const userResult = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [userEmail]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const userId = userResult.rows[0].id;

    // Base query parameters
    const queryParams = [userId, thread_id];
    let folderCondition = "f.type IN ('inbox', 'sent')"; // Default condition

    // If folder parameter is provided, override the condition
    if (folder) {
      folderCondition = "f.type = $3";
      queryParams.push(folder.toLowerCase()); // Ensure case consistency
    }

    // Fetch emails based on folder condition
    const { rows } = await pool.query(
      `SELECT 
        m.*,
        f.folder_id as folder_info_id,
        f.name as folder_name,
        f.type as folder_type
       FROM mailboxes m
       JOIN folders f ON m.folder_id = f.folder_id
       WHERE m.user_id = $1 
         AND m.thread_id = $2
         AND ${folderCondition}
       ORDER BY m.created_at ASC`,
      queryParams
    );

    if (rows.length === 0) {
      return res.status(404).json({ 
        error: "No emails found",
        details: folder 
          ? `No emails found in ${folder} folder for this thread`
          : "No emails found in Inbox or Sent folders for this thread"
      });
    }

    // Transform the response to include folder info
    const threadEmails = rows.map(row => {
      const email = {
        id: row.id,
        subject: row.subject,
        body: row.body,
        from_email: row.from_email,
        to_email: row.to_email,
        cc: row.cc,
        bcc: row.bcc,
        created_at: row.created_at,
        updated_at: row.updated_at,
        thread_id: row.thread_id,
        is_read: row.is_read,
        is_starred: row.is_starred,
        folder_info: {
          folder_id: row.folder_info_id,
          name: row.folder_name,
          type: row.folder_type
        },
        message_id: row.message_id,
        in_reply_to: row.in_reply_to,
        has_attachments: row.has_attachments,
        attachments: row.attachments,
        labels: row.labels
      };
      return email;
    });

    res.status(200).json({ 
      success: true,
      threadEmails,
      count: threadEmails.length,
      threadId: thread_id,
      folder: folder || 'inbox,sent' // Show which folders were queried
    });

  } catch (error) {
    console.error("Error fetching thread emails:", {
      message: error.message,
      stack: error.stack,
      query: error.query || 'Not available'
    });
    
    res.status(500).json({ 
      error: "Internal server error",
      details: process.env.NODE_ENV === 'development' ? {
        message: error.message,
        query: error.query || 'Not available'
      } : undefined
    });
  }
};


  const getEmailByMessageId = async (req, res) => {
    try {
        const userEmail = req.user.email;
        const { messageId } = req.params;

        if (!userEmail) {
            return res.status(400).json({ error: "Missing email in headers" });
        }

        if (!messageId) {
            return res.status(400).json({ error: "Missing message_id parameter" });
        }

        // Get user ID (if still needed for other purposes)
        const userResult = await pool.query(
            "SELECT id FROM users WHERE email = $1",
            [userEmail]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        // Fetch single email by message_id with your requested query
        const { rows } = await pool.query(
            `SELECT * FROM mailboxes
             WHERE (from_email = $1 OR to_email = $1)
             AND message_id = $2
             AND ($1 = ANY(ARRAY[from_email, to_email]))`,
            [userEmail, messageId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ 
                error: "Email not found or unauthorized",
                details: "No email found with the specified message_id that belongs to you"
            });
        }

        res.status(200).json({ 
            success: true,
            email: rows[0] 
        });

    } catch (error) {
        console.error("Error fetching email:", error);
        res.status(500).json({ 
            success: false,
            error: "Internal server error",
            details: process.env.NODE_ENV === 'development' ? {
                message: error.message,
                stack: error.stack
            } : undefined
        });
    }
};
  
    




// const nodemailer = require("nodemailer");
// const fs = require("fs");
// const { v4: uuidv4 } = require("uuid");
// const pool = require("../utils/db");

// API 1: Store Email in Database
const storeEmailInDb = async (req, res) => {
  const {
    to_email,
    cc = "",
    bcc = "",
    is_reply = false,
    in_reply_to = null,
    is_draft = false,
    attachments = [],
    message_id = null,
    encryptionType,
    encryptedData = [],
    subject: fallbackSubject,
    body: fallbackBody,
    plainText: fallbackPlainText
  } = req.body;

  const client = await pool.connect();
  const hasAttachments = attachments.length > 0;
  let threadId;
  const finalMessageId = message_id || `<${uuidv4()}@mail.abysfin.com>`;

  try {
    await client.query("BEGIN");

    // Get user info
    const userResult = await client.query(
      `SELECT id, email, preferences->>'hideSenderIP' as hide_sender_ip
       FROM users WHERE id = $1`,
      [req.user.user_id]
    );

    if (userResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "User not found" });
    }

    const userId = userResult.rows[0].id;
    const from_email = userResult.rows[0].email;
    const hideSenderIP = userResult.rows[0].hide_sender_ip === 'true';

    // Get sent folder
    const sentFolderResult = await client.query(
      "SELECT folder_id as id FROM folders WHERE user_id = $1 AND type = 'sent'",
      [userId]
    );

    if (sentFolderResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: "Sent folder not found" });
    }

    const sentFolderId = sentFolderResult.rows[0].id;
    const isEncrypted = encryptionType === 'openpgp' && encryptedData.length > 0;

    // Database content preparation
const dbContent = {
  subject: isEncrypted ? encryptedData[0]?.encryptedSubject : fallbackSubject,
  body: isEncrypted ? encryptedData[0]?.encryptedBody : fallbackBody,
  plain_text: isEncrypted ? 'Encrypted content' : fallbackPlainText,
  is_encrypted: isEncrypted,
  is_pgp_encrypted: isEncrypted,
  encryption_type: isEncrypted ? 'pgp' : null,
  has_attachments: hasAttachments,
  attachments: hasAttachments ? JSON.stringify(
    attachments.map(a => ({
      id: a.id,
      name: a.name,
      size: a.size,
      type: a.type,
      encryptedData: a.encryptedData,
      metadata: {
        encryptedAt: a.metadata?.encryptedAt || new Date().toISOString(),
        keyId: a.metadata?.keyId || 'unknown'
      }
    }))
  ) : null
};

    // Existing draft handling
    if (message_id) {
      const draftCheck = await client.query(
        `SELECT thread_id FROM mailboxes 
         WHERE message_id = $1 AND user_id = $2 AND is_draft = true`,
        [message_id, userId]
      );

      if (draftCheck.rows.length > 0) {
        threadId = draftCheck.rows[0].thread_id;
        await client.query(
          `UPDATE mailboxes SET 
           folder_id = $1, subject = $2, body = $3, plain_text = $4,
           to_email = $5, cc = $6, bcc = $7, is_draft = false,
           is_encrypted = $8, has_attachments = $9, attachments = $10, message_type = $13
           WHERE message_id = $11 AND user_id = $12`,
          [sentFolderId, dbContent.subject, dbContent.body, dbContent.plain_text,
           to_email, cc, bcc, dbContent.is_encrypted, 
           dbContent.has_attachments, dbContent.attachments,
           message_id, userId, "Sent"], 
        );
      }
    }

    // New message handling
    if (!threadId) {
      if (is_reply && in_reply_to) {
        const threadResult = await client.query(
          "SELECT thread_id FROM mailboxes WHERE message_id = $1 AND user_id = $2",
          [in_reply_to, userId]
        );
        threadId = threadResult.rows[0]?.thread_id || uuidv4();
      } else {
        threadId = uuidv4();
      }

      await client.query(
        `INSERT INTO mailboxes (
          user_id, folder_id, subject, body, plain_text,
          from_email, to_email, cc, bcc, thread_id, message_id,
          is_encrypted, has_attachments, attachments, message_type
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [userId, sentFolderId, dbContent.subject, dbContent.body, dbContent.plain_text,
         from_email, to_email, cc, bcc, threadId, finalMessageId,
         dbContent.is_encrypted, dbContent.has_attachments, dbContent.attachments, 'Sent']
      );
    }

    await client.query("COMMIT");
    res.status(200).json({
      message: "Email stored successfully",
      message_id: finalMessageId,
      thread_id: threadId,
      is_encrypted: isEncrypted
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Database operation failed", details: err.message });
  } finally {
    client.release();
  }
};


//Store multiple emails in db
const storeEmailsInDb = async (req, res) => {
  const {
    emails, // Array of email objects
    is_reply = false,
    in_reply_to = null,
    is_draft = false,
    encryptionType,
    encryptedData = []
  } = req.body;

  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: "No emails provided" });
  }

  const client = await pool.connect();
  let results = [];
  let hasError = false;

  try {
    await client.query("BEGIN");

    // Get user info once for all emails
    const userResult = await client.query(
      `SELECT id, email, preferences->>'hideSenderIP' as hide_sender_ip
       FROM users WHERE id = $1`,
      [req.user.user_id]
    );

    if (userResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "User not found" });
    }

    const userId = userResult.rows[0].id;
    const from_email = userResult.rows[0].email;
    const hideSenderIP = userResult.rows[0].hide_sender_ip === 'true';

    // Get sent folder once for all emails
    const sentFolderResult = await client.query(
      "SELECT folder_id as id FROM folders WHERE user_id = $1 AND type = 'sent'",
      [userId]
    );

    if (sentFolderResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: "Sent folder not found" });
    }

    const sentFolderId = sentFolderResult.rows[0].id;

    for (const email of emails) {
      try {
        const {
          to_email,
          cc = "",
          bcc = "",
          attachments = [],
          message_id = null,
          subject: fallbackSubject,
          body: fallbackBody,
          plainText: fallbackPlainText
        } = email;

        const hasAttachments = attachments.length > 0;
        let threadId;
        const finalMessageId = message_id || `<${uuidv4()}@mail.abysfin.com>`;
        const isEncrypted = encryptionType === 'openpgp' && encryptedData.length > 0;

        // Database content preparation
      const dbContent = {
  subject: isEncrypted ? encryptedData[0]?.encryptedSubject : fallbackSubject,
  body: isEncrypted ? encryptedData[0]?.encryptedBody : fallbackBody,
  plain_text: isEncrypted ? 'Encrypted content' : fallbackPlainText,
  is_encrypted: isEncrypted,
  is_pgp_encrypted: isEncrypted,
  encryption_type: isEncrypted ? 'pgp' : null,
  has_attachments: hasAttachments,
  attachments: hasAttachments ? JSON.stringify(attachments.map(a => ({
    id: a.id,
    name: a.name,
    size: a.size,
    type: a.type,
    ...(isEncrypted && {  // Only include encryption-related fields if encrypted
      encryptedData: a.encryptedData,
      metadata: {
        encryptedAt: a.metadata?.encryptedAt || new Date().toISOString(),
        keyId: a.metadata?.keyId || (publicKey ? publicKey.getKeyID().toHex() : 'unknown')
      }
    })
  }))) : null
};

        // Existing draft handling
        if (message_id) {
          const draftCheck = await client.query(
            `SELECT thread_id FROM mailboxes 
             WHERE message_id = $1 AND user_id = $2 AND is_draft = true`,
            [message_id, userId]
          );

          if (draftCheck.rows.length > 0) {
            threadId = draftCheck.rows[0].thread_id;
            await client.query(
              `UPDATE mailboxes SET 
               folder_id = $1, subject = $2, body = $3, plain_text = $4,
               to_email = $5, cc = $6, bcc = $7, is_draft = false,
               is_encrypted = $8, has_attachments = $9, attachments = $10, message_type = $13
               WHERE message_id = $11 AND user_id = $12`,
              [sentFolderId, dbContent.subject, dbContent.body, dbContent.plain_text,
               to_email, cc, bcc, dbContent.is_encrypted, 
               dbContent.has_attachments, dbContent.attachments,
               message_id, userId, "Sent"], 
            );
          }
        }

        // New message handling
        if (!threadId) {
          if (is_reply && in_reply_to) {
            const threadResult = await client.query(
              "SELECT thread_id FROM mailboxes WHERE message_id = $1 AND user_id = $2",
              [in_reply_to, userId]
            );
            threadId = threadResult.rows[0]?.thread_id || uuidv4();
          } else {
            threadId = uuidv4();
          }

          await client.query(
            `INSERT INTO mailboxes (
              user_id, folder_id, subject, body, plain_text,
              from_email, to_email, cc, bcc, thread_id, message_id,
              is_encrypted, has_attachments, attachments, message_type
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [userId, sentFolderId, dbContent.subject, dbContent.body, dbContent.plain_text,
             from_email, to_email, cc, bcc, threadId, finalMessageId,
             dbContent.is_encrypted, dbContent.has_attachments, dbContent.attachments, 'Sent']
          );
        }

        results.push({
          message: "Email stored successfully",
          message_id: finalMessageId,
          thread_id: threadId,
          is_encrypted: isEncrypted,
          to_email: to_email
        });
      } catch (err) {
        hasError = true;
        results.push({
          error: "Failed to store email",
          details: err.message,
          email: email
        });
        // Continue with next email even if one fails
      }
    }

    if (hasError) {
      // At least one email failed, but others might have succeeded
      await client.query("COMMIT");
      return res.status(207).json({ // 207 Multi-Status
        results: results,
        message: "Some emails were not stored successfully"
      });
    }

    await client.query("COMMIT");
    res.status(200).json({
      results: results,
      message: "All emails stored successfully"
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Database operation failed", details: err.message });
  } finally {
    client.release();
  }
};

// API 2: Send Email
const sendEmail = async (req, res) => {
  const {
    to_email,
    cc = "",
    bcc = "",
    is_reply = false,
    in_reply_to = null,
    attachments = [],
    message_id,
    encryptionType,
    encryptedData = [],
    subject: fallbackSubject,
    body: fallbackBody,
    plainText: fallbackPlainText
  } = req.body;

  const clientIp = req.headers['x-forwarded-for'] || req.ip;
  const currentDate = new Date().toUTCString();
  const hasAttachments = attachments.length > 0;
  const finalMessageId = message_id || `<${uuidv4()}@mail.abysfin.com>`;

  try {
    // Get user info
    const userResult = await pool.query(
      `SELECT email, preferences->>'hideSenderIP' as hide_sender_ip
       FROM users WHERE id = $1`,
      [req.user.user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const { email: from_email, hide_sender_ip } = userResult.rows[0];
    const hideSenderIP = hide_sender_ip === 'true';
    const isEncrypted = encryptionType === 'openpgp' && encryptedData.length > 0;
    const isInternal = to_email.endsWith('@abysfin.com');

    // Prepare headers
    const headers = {
      "Message-ID": finalMessageId,
      "Date": currentDate,
      "From": from_email,
      "To": to_email,
      "Subject": isEncrypted ? '[Encrypted]' : fallbackSubject,
      ...(!hideSenderIP && { "X-Sender-IP": clientIp }),
      ...(cc && { "Cc": cc }),
      ...(bcc && { "Bcc": bcc }),
      ...(is_reply && in_reply_to && {
        "In-Reply-To": in_reply_to,
        "References": in_reply_to
      }),
      ...(hasAttachments && { 
        "X-Has-Attachments": "true",
        "X-Attachment-Count": attachments.length.toString()
      }),
      ...(isEncrypted && {
        "X-Encrypted": "OpenPGP",
        "X-Encryption-Type": "openpgp"
      })
    };

    // Send email
    const transporter = nodemailer.createTransport({
      host: "localhost",
      port: 25,
      secure: false,
      tls: { rejectUnauthorized: false }
    });

    if (isEncrypted) {
      await Promise.all(encryptedData.map(async recipientData => {
        await transporter.sendMail({
          from: from_email,
          to: recipientData.email,
          subject: recipientData.encryptedSubject,
          html: recipientData.encryptedBody,
          text: 'Encrypted content',
          headers: { ...headers, 'To': recipientData.email },
          attachments: attachments
        });
      }));

      if (!isInternal && fallbackSubject && fallbackBody) {
        await transporter.sendMail({
          from: from_email,
          to: to_email,
          subject: fallbackSubject,
          html: fallbackBody,
          text: fallbackPlainText,
          headers: headers,
          attachments: attachments
        });
      }
    } else {
      await transporter.sendMail({
        from: from_email,
        to: to_email,
        cc,
        bcc,
        subject: fallbackSubject,
        html: fallbackBody,
        text: fallbackPlainText,
        headers: headers,
        attachments: attachments
      });
    }

    res.status(200).json({
      message: "Email sent",
      message_id: finalMessageId,
      encrypted: isEncrypted,
      fallback_used: isEncrypted && !isInternal,
      
    });
  } catch (err) {
    console.error("Email send error:", err);
    res.status(500).json({ error: "Failed to send email", details: err.message });
  }
};

function extractFingerprint(publicKey) {
  try {
    const modernMatch = publicKey.match(/^([0-9A-F]{16,40})/m);
    if (modernMatch) return modernMatch[1];
    
    const legacyMatch = publicKey.match(/Key fingerprint = ([0-9A-F ]+)/i);
    return legacyMatch ? legacyMatch[1].replace(/\s/g, '') : null;
  } catch {
    return null;
  }
}



const saveDraft = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      to_email = "",
      cc = "",
      bcc = "",
      subject = "",
      body = "",
      plainText = "",
      in_reply_to = null,
      message_id = null,
      thread_id = null,
      attachments = []
    } = req.body;

    // Validate user exists
    const userResult = await client.query(
      "SELECT id, email FROM users WHERE id = $1",
      [req.user.user_id]
    );

    if (userResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(401).json({ message: "Unauthorized" });
    }

    const userId = userResult.rows[0].id;
    const from_email = userResult.rows[0].email;

    // Get or create drafts folder (modified to remove ON CONFLICT)
    let draftFolderId;
    const folderResult = await client.query(
      `SELECT folder_id FROM folders WHERE user_id = $1 AND type = 'drafts'`,
      [userId]
    );

    if (folderResult.rows.length === 0) {
      const newFolder = await client.query(
        `INSERT INTO folders (user_id, name, type) VALUES ($1, 'Drafts', 'drafts') RETURNING folder_id`,
        [userId]
      );
      draftFolderId = newFolder.rows[0].folder_id;
    } else {
      draftFolderId = folderResult.rows[0].folder_id;
    }

    // Validate draft content
    const hasContent = [subject, body, plainText].some(v => v && v.trim() !== "");
    const hasRecipient = [to_email, cc, bcc].some(v => v && v.trim() !== "");

    if (!hasContent && !hasRecipient) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cannot save empty draft" });
    }

    // Handle existing draft (modified to use explicit check)
    if (message_id) {
      const existingDraft = await client.query(
        `SELECT id FROM mailboxes WHERE message_id = $1 AND user_id = $2 AND is_draft = true`,
        [message_id, userId]
      );

      if (existingDraft.rows.length > 0) {
        const updateResult = await client.query(
          `UPDATE mailboxes SET
            subject = $1, 
            body = $2, 
            plain_text = $3,
            to_email = NULLIF($4, ''), 
            cc = NULLIF($5, ''), 
            bcc = NULLIF($6, ''),
            in_reply_to = $7, 
            attachments = $8
          WHERE id = $9
          RETURNING thread_id, folder_id`,
          [
            subject, 
            body, 
            plainText, 
            to_email, 
            cc, 
            bcc, 
            in_reply_to, 
            attachments, 
            existingDraft.rows[0].id
          ]
        );

        if (updateResult.rows[0].folder_id !== draftFolderId) {
          await client.query(
            `UPDATE mailboxes SET folder_id = $1 WHERE id = $2`,
            [draftFolderId, existingDraft.rows[0].id]
          );
        }

        await client.query("COMMIT");
        return res.status(200).json({
          message: "Draft updated",
          message_id,
          thread_id: updateResult.rows[0].thread_id || thread_id
        });
      }
    }

    // Create new draft
    const newMessageId = `<${uuidv4()}@${process.env.DOMAIN || 'abysfin.com'}>`;
    const newThreadId = thread_id || uuidv4();

    const insertResult = await client.query(
      `INSERT INTO mailboxes (
        user_id, folder, folder_id, subject, body, plain_text,
        from_email, to_email, cc, bcc, is_read,
        thread_id, message_id, in_reply_to, is_draft, message_type, attachments
      ) VALUES (
        $1, 'Drafts', $2, $3, $4, $5, $6, 
        NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), true,
        $10, $11, $12, true, 'drafts', $13
      ) RETURNING message_id, thread_id`,
      [
        userId, draftFolderId, subject, body, plainText, from_email,
        to_email, cc, bcc, newThreadId, newMessageId, 
        in_reply_to, attachments
      ]
    );

    await client.query("COMMIT");
    res.status(201).json({
      message: "Draft created",
      message_id: insertResult.rows[0].message_id,
      thread_id: insertResult.rows[0].thread_id
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Draft save error:", {
      message: err.message,
      stack: err.stack,
      body: req.body,
      user: req.user
    });
    
    res.status(500).json({
      message: "Failed to save draft",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    client.release();
  }
};





const moveEmailToSpam = async (req, res) => {
  const client = await pool.connect(); // Get a client for transaction
  const messageId = req.params.messageId;
  const userEmail = req.user.email;

  if (!messageId || !userEmail) {
    return res.status(400).json({ error: "Missing message ID or user information." });
  }

  try {
    await client.query('BEGIN'); // Start transaction

    // 1. Get user ID and verify email belongs to user
    const userResult = await client.query(
      `SELECT id FROM users WHERE email = $1`,
      [userEmail]
    );
    
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "User not found." });
    }
    
    const userId = userResult.rows[0].id;

    // 2. Get the Spam folder ID for this user
    const folderResult = await client.query(
      `SELECT folder_id FROM folders 
       WHERE user_id = $1 AND type = 'spam'`,
      [userId]
    );
    
    if (folderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: "Spam folder not found." });
    }
    
    const spamFolderId = folderResult.rows[0].folder_id;

    // 3. Update the email's folder and folder_id
    const updateResult = await client.query(
      `UPDATE mailboxes 
       SET folder = 'Spam', folder_id = $1
       WHERE message_id = $2 AND user_id = $3
       RETURNING id`,
      [spamFolderId, messageId, userId]
    );

    if (updateResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        error: "Email not found or you don't have permission to modify it." 
      });
    }

    await client.query('COMMIT');
    res.status(200).json({ 
      message: "Email moved to Spam successfully.",
      folder_id: spamFolderId
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error moving email to spam:", error);
    res.status(500).json({ 
      error: "Failed to move email to Spam.",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
};


const moveThreadToSpam = async (req, res) => {
  const threadId = req.params.threadId;
  const userEmail = req.user.email;

  if (!threadId || !userEmail) {
    return res.status(400).json({ error: "Missing thread ID or user information." });
  }

  try {
    const result = await pool.query(
      `UPDATE mailboxes 
       SET folder = 'Spam'
       WHERE thread_id = $1 AND (from_email = $2 OR to_email = $2)`,
      [threadId, userEmail]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Email not found or unauthorized." });
    }

    res.status(200).json({ message: "Email moved to Spam successfully." });
  } catch (error) {
    console.error("Error moving email to spam:", error);
    res.status(500).json({ error: "Failed to move email to Trash." });
  }
};


  


const moveToTrash = async (req, res) => {
  const client = await pool.connect(); // Get a client for transaction
  const messageId = req.params.messageId;
  const userEmail = req.user.email;

  if (!messageId || !userEmail) {
    return res.status(400).json({ error: "Missing message ID or user information." });
  }

  try {
    await client.query('BEGIN'); // Start transaction

    // 1. Get user ID and verify email belongs to user
    const userResult = await client.query(
      `SELECT id FROM users WHERE email = $1`,
      [userEmail]
    );
    
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "User not found." });
    }
    
    const userId = userResult.rows[0].id;

    // 2. Get the Trash folder ID for this user
    const folderResult = await client.query(
      `SELECT folder_id FROM folders 
       WHERE user_id = $1 AND type = 'trash'`,
      [userId]
    );
    
    if (folderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: "Trash folder not found." });
    }
    
    const trashFolderId = folderResult.rows[0].folder_id;

    // 3. Update the email's folder and folder_id
    const updateResult = await client.query(
      `UPDATE mailboxes 
       SET folder = 'Trash', folder_id = $1
       WHERE message_id = $2 AND user_id = $3
       RETURNING id`,
      [trashFolderId, messageId, userId]
    );

    if (updateResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        error: "Email not found or you don't have permission to modify it." 
      });
    }

    await client.query('COMMIT');
    res.status(200).json({ 
      message: "Email moved to Trash successfully.",
      folder_id: trashFolderId
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error moving email to trash:", error);
    res.status(500).json({ 
      error: "Failed to move email to Trash.",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
};
  

const moveThreadToTrash = async (req, res) => {
  const client = await pool.connect(); // Get a client for transaction
  const threadId = req.params.threadId;
  const userEmail = req.user.email;

  if (!threadId || !userEmail) {
    return res.status(400).json({ error: "Missing thread ID or user information." });
  }

  try {
    await client.query('BEGIN'); // Start transaction

    // 1. Get user ID and verify user exists
    const userResult = await client.query(
      `SELECT id FROM users WHERE email = $1`,
      [userEmail]
    );
    
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "User not found." });
    }
    
    const userId = userResult.rows[0].id;

    // 2. Get the Trash folder ID for this user
    const folderResult = await client.query(
      `SELECT folder_id FROM folders 
       WHERE user_id = $1 AND type = 'trash'`,
      [userId]
    );
    
    if (folderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: "Trash folder not found." });
    }
    
    const trashFolderId = folderResult.rows[0].folder_id;

    // 3. Update all emails in the thread to Trash folder
    const updateResult = await client.query(
      `UPDATE mailboxes 
       SET folder = 'Trash', folder_id = $1
       WHERE thread_id = $2 AND user_id = $3
       RETURNING id`,
      [trashFolderId, threadId, userId]
    );

    if (updateResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        error: "Thread not found or you don't have permission to modify it." 
      });
    }

    await client.query('COMMIT');
    res.status(200).json({ 
      message: "Thread moved to Trash successfully.",
      folder_id: trashFolderId,
      updatedEmailsCount: updateResult.rowCount
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error moving thread to trash:", error);
    res.status(500).json({ 
      error: "Failed to move thread to Trash.",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
};

  const deleteEmail = async (req, res) => {
    const messageId = req.params.messageId;
    const userEmail = req.user.email; // assuming you're using JWT middleware that sets req.user
  
    if (!messageId || !userEmail) {
      return res.status(400).json({ error: "Missing message ID or user info" });
    }
  
    try {
      // Optional: Soft delete - move to trash/bin folder instead
      // await pool.query(
      //   "UPDATE mailboxes SET folder = 'Bin' WHERE message_id = $1 AND from_email = $2",
      //   [messageId, userEmail]
      // );
  
      // Hard delete:
      const result = await pool.query(
        "DELETE FROM mailboxes WHERE message_id = $1 AND from_email = $2",
        [messageId, userEmail]
      );
  
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Email not found or unauthorized" });
      }
  
      res.status(200).json({ message: "Email deleted successfully" });
    } catch (error) {
      console.error("Error deleting email:", error);
      res.status(500).json({ error: "Failed to delete email" });
    }
  };


  const deleteMultipleThreads = async (req, res) => {
    const client = await pool.connect();
    const threadIds = req.body.threadIds;
    const userId = req.user.user_id; // Using user_id from auth token

    // Validate inputs
    if (!Array.isArray(threadIds) || threadIds.length === 0) {
        await client.release();
        return res.status(400).json({ 
            error: "Invalid thread IDs",
            details: "threadIds array is required and must not be empty"
        });
    }

    try {
        await client.query('BEGIN');

        // 1. Get user email for verification
        const userResult = await client.query(
            "SELECT email FROM users WHERE id = $1", 
            [userId]
        );
        
        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "User not found." });
        }
        
        const userEmail = userResult.rows[0].email;

        // 2. Verify threads exist and belong to user
        const checkResult = await client.query(
            `SELECT thread_id::text FROM mailboxes 
             WHERE thread_id = ANY($1::uuid[]) 
             AND (from_email = $2 OR to_email = $2)
             GROUP BY thread_id`,
            [threadIds, userEmail]
        );

        const foundThreadIds = checkResult.rows.map(row => row.thread_id);
        const missingThreads = threadIds.filter(id => !foundThreadIds.includes(id));

        if (missingThreads.length > 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ 
                error: "Some threads not found or unauthorized",
                details: { missingThreads }
            });
        }

        // 3. Delete all emails from the specified threads
        const deleteResult = await client.query(
            `WITH deleted_emails AS (
                DELETE FROM mailboxes 
                WHERE thread_id = ANY($1::uuid[])
                AND (from_email = $2 OR to_email = $2)
                RETURNING id, thread_id::text
             )
             SELECT thread_id, COUNT(*) as count FROM deleted_emails
             GROUP BY thread_id`,
            [threadIds, userEmail]
        );

        // Group results by thread ID
        const resultsByThread = deleteResult.rows.reduce((acc, row) => {
            acc[row.thread_id] = row.count;
            return acc;
        }, {});

        await client.query('COMMIT');
        
        res.status(200).json({
            success: true,
            message: "Threads deleted successfully",
            data: {
                threadsProcessed: threadIds.length,
                emailsDeleted: deleteResult.rows.reduce((sum, row) => sum + row.count, 0),
                resultsByThread,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error deleting threads:", {
            message: error.message,
            stack: error.stack,
            query: error.query || 'Not available'
        });
        
        res.status(500).json({ 
            error: "Failed to delete threads",
            details: process.env.NODE_ENV === 'development' ? {
                message: error.message,
                code: error.code
            } : undefined
        });
    } finally {
        client.release();
    }
};


  const restoreThreadFromTrash = async (req, res) => {
    const client = await pool.connect(); // Get a client for transaction
    const threadId = req.params.threadId;
    const userEmail = req.user.email;
  
    if (!threadId || !userEmail) {
      return res.status(400).json({ 
        error: "Missing required parameters",
        details: {
          threadId: !threadId ? "Thread ID is required" : undefined,
          userEmail: !userEmail ? "User email is required" : undefined
        }
      });
    }
  
    try {
      await client.query('BEGIN'); // Start transaction
  
      // 1. Get user ID
      const userResult = await client.query(
        `SELECT id FROM users WHERE email = $1`,
        [userEmail]
      );
      
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "User not found." });
      }
      
      const userId = userResult.rows[0].id;
  
      // 2. Verify thread exists in Trash and user has permission
      const checkResult = await client.query(
        `SELECT m.id, m.message_type, m.from_email 
         FROM mailboxes m
         JOIN folders f ON m.folder_id = f.folder_id
         WHERE m.thread_id = $1 
         AND m.user_id = $2
         AND f.type = 'trash'`,
        [threadId, userId]
      );
  
      if (checkResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ 
          error: "No emails found in Trash",
          details: {
            suggestion: "Check if the thread exists and is in your Trash folder"
          }
        });
      }
  
      // 3. Get folder IDs for restoration destinations
      const folderResults = await client.query(
        `SELECT folder_id, type FROM folders 
         WHERE user_id = $1 AND type IN ('inbox', 'sent', 'drafts')`,
        [userId]
      );
  
      const folderMap = {};
      folderResults.rows.forEach(row => {
        folderMap[row.type] = row.folder_id;
      });
  
      // 4. Track restoration counts
      const restorationStats = {
        toInbox: 0,
        toSent: 0,
        toDrafts: 0
      };
  
      // 5. Process each email in the thread
      for (const row of checkResult.rows) {
        // Determine original folder based on message_type and sender
        let originalFolder = 'Inbox';
        let folderType = 'inbox';
        let folderId = folderMap.inbox;
  
        const messageType = row.message_type?.toLowerCase();
        const isSentByUser = row.from_email === userEmail;
  
        if (messageType === 'sent' || isSentByUser) {
          originalFolder = 'Sent';
          folderType = 'sent';
          folderId = folderMap.sent;
          restorationStats.toSent++;
        } else if (messageType === 'draft') {
          originalFolder = 'Drafts';
          folderType = 'drafts';
          folderId = folderMap.drafts;
          restorationStats.toDrafts++;
        } else {
          restorationStats.toInbox++;
        }
  
        // Restore to original folder with both folder name and ID
        await client.query(
          `UPDATE mailboxes 
           SET folder = $3, folder_id = $4
           WHERE id = $1 AND user_id = $2`,
          [row.id, userId, originalFolder, folderId]
        );
      }
  
      await client.query('COMMIT');
  
      // 6. Return success response
      res.status(200).json({ 
        success: true,
        message: "Thread restored from Trash successfully",
        data: {
          threadId,
          emailsRestored: checkResult.rowCount,
          restorationStats,
          previousFolder: 'Trash',
          folderMapping: folderMap
        }
      });
  
    } catch (error) {
      await client.query('ROLLBACK');
      console.error("Error restoring thread from Trash:", error);
      res.status(500).json({ 
        error: "Failed to restore thread from Trash",
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    } finally {
      client.release();
    }
  };


  const setEmailIsRead = async (req, res) => {
    const { is_read } = req.body;
    const { thread_id } = req.params;
        // Lookup verified sender email
        const userResult = await pool.query("SELECT email FROM users WHERE id = $1", [req.user.user_id]);
        const verifiedEmail = userResult.rows[0].email;
        const userEmail = verifiedEmail;
  
    if (!thread_id) {
      return res.status(400).json({ error: "Missing thread_id parameter." });
    }
  
    if (typeof is_read !== 'boolean') {
      return res.status(400).json({ error: "'is_read' must be true or false." });
    }
  
    try {
      const result = await pool.query(
        `UPDATE mailboxes 
         SET is_read = $1
         WHERE thread_id = $2
           AND (to_email = $3 OR from_email = $3)
           AND is_read != $1`, // Only update if value needs to change
        [is_read, thread_id, userEmail]
      );
  
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "No matching emails found or already updated." });
      }
  
      res.status(200).json({
        message: `All emails in thread marked as ${is_read ? 'read' : 'unread'}.`,
        updatedCount: result.rowCount
      });
    } catch (error) {
      console.error("Error updating thread read status:", error);
      res.status(500).json({ error: "Failed to update email read status." });
    }
  };

  const setThreadsReadStatus = async (req, res) => {
    const { is_read, threadIds } = req.body;
    const client = await pool.connect();

    // Validate inputs
    if (!Array.isArray(threadIds) || threadIds.length === 0) {
        return res.status(400).json({ 
            error: "Invalid thread IDs",
            details: "threadIds array is required and must not be empty"
        });
    }

    if (typeof is_read !== 'boolean') {
        return res.status(400).json({ 
            error: "Invalid read status",
            details: "'is_read' must be true or false"
        });
    }

    try {
        await client.query('BEGIN');

        // 1. Get user email
        const userResult = await client.query(
            "SELECT email FROM users WHERE id = $1", 
            [req.user.user_id]
        );
        
        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "User not found." });
        }
        
        const userEmail = userResult.rows[0].email;

        // 2. Update read status for all specified threads
        const updateResult = await client.query(
            `UPDATE mailboxes 
             SET is_read = $1
             WHERE thread_id = ANY($2::uuid[])
               AND (to_email = $3 OR from_email = $3)
               AND is_read != $1  -- Only update if status needs to change
             RETURNING thread_id::text, id`,
            [is_read, threadIds, userEmail]
        );

        if (updateResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ 
                error: "No matching emails found or already updated",
                details: {
                    threadsChecked: threadIds.length,
                    emailsUpdated: 0
                }
            });
        }

        // Group results by thread ID
        const resultsByThread = updateResult.rows.reduce((acc, row) => {
            if (!acc[row.thread_id]) {
                acc[row.thread_id] = [];
            }
            acc[row.thread_id].push(row.id);
            return acc;
        }, {});

        await client.query('COMMIT');
        
        res.status(200).json({
            success: true,
            message: `Threads marked as ${is_read ? 'read' : 'unread'}`,
            data: {
                threadsProcessed: threadIds.length,
                emailsUpdated: updateResult.rowCount,
                resultsByThread,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error updating thread read status:", {
            message: error.message,
            stack: error.stack,
            query: error.query || 'Not available'
        });
        
        res.status(500).json({ 
            error: "Failed to update read status",
            details: process.env.NODE_ENV === 'development' ? {
                message: error.message,
                code: error.code
            } : undefined
        });
    } finally {
        client.release();
    }
};
  
  
  
  const setEmailStarred = async (req, res) => {
    const messageId = req.params.messageId;
    const { is_starred } = req.body;
    const userEmail = req.user.email; // assuming JWT middleware sets req.user
  
    if (typeof is_starred !== 'boolean') {
      return res.status(400).json({ error: "'is_starred' must be true or false" });
    }
  
    try {
      const result = await pool.query(
        `UPDATE mailboxes 
         SET is_starred = $1 
         WHERE message_id = $2 AND (to_email = $3 OR from_email = $3)`,
        [is_starred, messageId, userEmail]
      );
  
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Email not found or unauthorized." });
      }
  
      res.status(200).json({ message: `Email ${is_starred ? 'starred' : 'unstarred'} successfully.` });
    } catch (error) {
      console.error("Error updating star status:", error);
      res.status(500).json({ error: "Failed to update email star status." });
    }
  };


  const moveMessageToArchive = async (req, res) => {
    const client = await pool.connect(); // Get a client for transaction
    const messageId = req.params.messageId;
    const userEmail = req.user.email;
  
    if (!messageId || !userEmail) {
      return res.status(400).json({ error: "Missing message ID or user information." });
    }
  
    try {
      await client.query('BEGIN'); // Start transaction
  
      // 1. Get user ID and verify user exists
      const userResult = await client.query(
        `SELECT id FROM users WHERE email = $1`,
        [userEmail]
      );
      
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "User not found." });
      }
      
      const userId = userResult.rows[0].id;
  
      // 2. Get the Archive folder ID for this user
      const folderResult = await client.query(
        `SELECT folder_id FROM folders 
         WHERE user_id = $1 AND type = 'archive'`,
        [userId]
      );
      
      if (folderResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: "Archive folder not found." });
      }
      
      const archiveFolderId = folderResult.rows[0].folder_id;
  
      // 3. Verify message exists and belongs to user
      const checkResult = await client.query(
        `SELECT id FROM mailboxes 
         WHERE message_id = $1 AND user_id = $2`,
        [messageId, userId]
      );
  
      if (checkResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "Email not found or unauthorized." });
      }
  
      // 4. Update the message's folder and folder_id
      const updateResult = await client.query(
        `UPDATE mailboxes 
         SET folder = 'Archive', folder_id = $1
         WHERE message_id = $2 AND user_id = $3
         RETURNING id`,
        [archiveFolderId, messageId, userId]
      );
  
      await client.query('COMMIT');
      res.status(200).json({ 
        message: "Email moved to Archive successfully.",
        data: {
          messageId,
          newFolder: 'Archive',
          folder_id: archiveFolderId
        }
      });
  
    } catch (error) {
      await client.query('ROLLBACK');
      console.error("Error moving email to archive:", error);
      res.status(500).json({ 
        error: "Failed to move email to Archive.",
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    } finally {
      client.release();
    }
  };


  const moveThreadToArchive = async (req, res) => {
    const client = await pool.connect(); // Get a client for transaction
    const threadId = req.params.threadId;
    const userEmail = req.user.email;
  
    if (!threadId || !userEmail) {
      return res.status(400).json({ 
        error: "Missing thread ID or user information.",
        details: {
          threadId: !threadId ? "Thread ID is required" : undefined,
          userEmail: !userEmail ? "User email is required" : undefined
        }
      });
    }
  
    try {
      await client.query('BEGIN'); // Start transaction
  
      // 1. Get user ID and verify user exists
      const userResult = await client.query(
        `SELECT id FROM users WHERE email = $1`,
        [userEmail]
      );
      
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "User not found." });
      }
      
      const userId = userResult.rows[0].id;
  
      // 2. Get the Archive folder ID for this user
      const folderResult = await client.query(
        `SELECT folder_id FROM folders 
         WHERE user_id = $1 AND type = 'archive'`,
        [userId]
      );
      
      if (folderResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(500).json({ 
          error: "Archive folder not found.",
          suggestion: "System folders may not be properly configured"
        });
      }
      
      const archiveFolderId = folderResult.rows[0].folder_id;
  
      // 3. Verify thread exists and belongs to user
      const checkResult = await client.query(
        `SELECT id FROM mailboxes 
         WHERE thread_id = $1 AND user_id = $2
         LIMIT 1`, // Just need to check existence
        [threadId, userId]
      );
  
      if (checkResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ 
          error: "No emails found with this thread ID or unauthorized.",
          details: {
            threadId,
            userId
          }
        });
      }
  
      // 4. Update all emails in the thread to Archive folder
      const updateResult = await client.query(
        `UPDATE mailboxes 
         SET folder = 'Archive', folder_id = $1
         WHERE thread_id = $2 AND user_id = $3
         RETURNING id`,
        [archiveFolderId, threadId, userId]
      );
  
      await client.query('COMMIT');
      
      res.status(200).json({ 
        success: true,
        message: "Thread moved to Archive successfully.",
        data: {
          threadId,
          newFolder: 'Archive',
          folder_id: archiveFolderId,
          emailsUpdated: updateResult.rowCount,
          timestamp: new Date().toISOString()
        }
      });
  
    } catch (error) {
      await client.query('ROLLBACK');
      console.error("Error moving thread to archive:", error);
      res.status(500).json({ 
        error: "Failed to move thread to Archive.",
        details: process.env.NODE_ENV === 'development' ? {
          message: error.message,
          stack: error.stack
        } : undefined
      });
    } finally {
      client.release();
    }
  };

  const moveThreadsToArchive = async (req, res) => {
    const client = await pool.connect();
    const threadIds = req.body.threadIds;
    const userEmail = req.user.email;

    // Validate threadIds are valid UUIDs if that's your database schema
    if (!threadIds || !Array.isArray(threadIds) || threadIds.length === 0 || !userEmail) {
        return res.status(400).json({ 
            error: "Missing thread IDs or user information.",
            details: {
                threadIds: !threadIds || !Array.isArray(threadIds) || threadIds.length === 0 
                    ? "Thread IDs array is required and must not be empty" 
                    : undefined,
                userEmail: !userEmail ? "User email is required" : undefined
            }
        });
    }
    

    try {
        await client.query('BEGIN');

        // 1. Get user ID
        const userResult = await client.query(
            `SELECT id FROM users WHERE email = $1`,
            [userEmail]
        );
        
        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "User not found." });
        }
        
        const userId = userResult.rows[0].id;

        // 2. Get Archive folder ID
        const folderResult = await client.query(
            `SELECT folder_id FROM folders 
             WHERE user_id = $1 AND type = 'archive'`,
            [req.user.user_id]
        );
        
        if (folderResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(500).json({ 
                error: "Archive folder not found.",
                suggestion: "System folders may not be properly configured"
            });
        }
        
        const archiveFolderId = folderResult.rows[0].folder_id;

        // 3. Verify threads exist - using explicit type casting for UUIDs
        const checkResult = await client.query(
            `SELECT thread_id::text FROM mailboxes 
             WHERE thread_id = ANY($1::uuid[]) AND user_id = $2
             GROUP BY thread_id`,
            [threadIds, userId]
        );

        const foundThreadIds = checkResult.rows.map(row => row.thread_id);
        const missingThreads = threadIds.filter(id => !foundThreadIds.includes(id));

        if (missingThreads.length > 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ 
                error: "Some threads not found or unauthorized.",
                details: {
                    missingThreads,
                    userId
                }
            });
        }

        // 4. Update emails - explicit type casting for UUID array
        const updateResult = await client.query(
            `UPDATE mailboxes 
             SET folder = 'Archive', folder_id = $1
             WHERE thread_id = ANY($2::uuid[]) AND user_id = $3
             RETURNING thread_id::text, id`,
            [archiveFolderId, threadIds, userId]
        );

        // Group results
        const resultsByThread = updateResult.rows.reduce((acc, row) => {
            if (!acc[row.thread_id]) {
                acc[row.thread_id] = [];
            }
            acc[row.thread_id].push(row.id);
            return acc;
        }, {});

        await client.query('COMMIT');
        
        res.status(200).json({ 
            success: true,
            message: "Threads moved to Archive successfully.",
            data: {
                archiveFolderId,
                threadsProcessed: threadIds.length,
                emailsUpdated: updateResult.rowCount,
                resultsByThread,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error moving threads to archive:", {
            message: error.message,
            stack: error.stack,
            details: error.detail || 'No additional details'
        });
        res.status(500).json({ 
            error: "Failed to move threads to Archive.",
            details: {
                message: error.message,
                stack: error.stack,
                databaseError: error.detail
            } 
        });
    } finally {
        client.release();
    }
};
  
  const restoreFromArchive = async (req, res) => {
    const client = await pool.connect(); // Get a client for transaction
    const messageId = req.params.messageId;
    const userEmail = req.user.email;
  
    if (!messageId || !userEmail) {
      return res.status(400).json({ 
        error: "Missing message ID or user information.",
        details: {
          messageId: !messageId ? "Message ID is required" : undefined,
          userEmail: !userEmail ? "User email is required" : undefined
        }
      });
    }
  
    try {
      await client.query('BEGIN'); // Start transaction
  
      // 1. Get user ID and verify user exists
      const userResult = await client.query(
        `SELECT id FROM users WHERE email = $1`,
        [userEmail]
      );
      
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "User not found." });
      }
      
      const userId = userResult.rows[0].id;
  
      // 2. Verify email exists in Archive and belongs to user
      const checkResult = await client.query(
        `SELECT m.id, m.message_type, m.from_email, f.folder_id as archive_folder_id
         FROM mailboxes m
         JOIN folders f ON m.folder_id = f.folder_id
         WHERE m.message_id = $1 
         AND m.user_id = $2
         AND f.type = 'archive'`,
        [messageId, userId]
      );
  
      if (checkResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ 
          error: "Archived email not found or unauthorized.",
          details: {
            suggestion: "Check if the email exists and is in your Archive folder"
          }
        });
      }
  
      const messageData = checkResult.rows[0];
      const isSentByUser = messageData.from_email === userEmail;
  
      // 3. Determine original folder based on message_type and sender
      let originalFolder = 'Inbox';
      let folderType = 'inbox';
      
      const messageType = messageData.message_type?.toLowerCase();
      if (messageType === 'sent' || isSentByUser) {
        originalFolder = 'Sent';
        folderType = 'sent';
      } else if (messageType === 'draft') {
        originalFolder = 'Drafts';
        folderType = 'drafts';
      }
  
      // 4. Get the destination folder ID
      const folderResult = await client.query(
        `SELECT folder_id FROM folders 
         WHERE user_id = $1 AND type = $2`,
        [userId, folderType]
      );
      
      if (folderResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(500).json({ 
          error: "Destination folder not found.",
          details: {
            requestedFolder: originalFolder,
            folderType
          }
        });
      }
      
      const destinationFolderId = folderResult.rows[0].folder_id;
  
      // 5. Restore to original folder with proper folder_id
      const updateResult = await client.query(
        `UPDATE mailboxes 
         SET folder = $3, folder_id = $4
         WHERE message_id = $1 AND user_id = $2
         RETURNING id`,
        [messageId, userId, originalFolder, destinationFolderId]
      );
  
      await client.query('COMMIT');
      
      res.status(200).json({ 
        success: true,
        message: "Email restored from Archive successfully.",
        data: {
          messageId,
          restoredFolder: originalFolder,
          folder_id: destinationFolderId,
          previousFolder: 'Archive',
          messageType: messageData.message_type,
          archiveFolderId: messageData.archive_folder_id
        }
      });
  
    } catch (error) {
      await client.query('ROLLBACK');
      console.error("Error restoring email from archive:", error);
      res.status(500).json({ 
        error: "Failed to restore email from Archive.",
        details: process.env.NODE_ENV === 'development' ? {
          message: error.message,
          stack: error.stack
        } : undefined
      });
    } finally {
      client.release();
    }
  };

  const restoreThreadFromArchive = async (req, res) => {
    const client = await pool.connect(); // Get a client for transaction
    const threadId = req.params.threadId;
    const userEmail = req.user.email;
  
    if (!threadId || !userEmail) {
      return res.status(400).json({ 
        error: "Missing thread ID or user information.",
        details: {
          threadId: !threadId ? "Thread ID is required" : undefined,
          userEmail: !userEmail ? "User email is required" : undefined
        }
      });
    }
  
    try {
      await client.query('BEGIN'); // Start transaction
  
      // 1. Get user ID and verify user exists
      const userResult = await client.query(
        `SELECT id FROM users WHERE email = $1`,
        [userEmail]
      );
      
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "User not found." });
      }
      
      const userId = userResult.rows[0].id;
  
      // 2. Get all folder mappings needed for restoration
      const folderResults = await client.query(
        `SELECT folder_id, type FROM folders 
         WHERE user_id = $1 AND type IN ('inbox', 'sent', 'drafts')`,
        [userId]
      );
  
      const folderMap = {};
      folderResults.rows.forEach(row => {
        folderMap[row.type] = row.folder_id;
      });
  
      // 3. Verify thread exists in Archive and belongs to user
      const checkResult = await client.query(
        `SELECT m.id, m.message_type, m.from_email, f.folder_id as archive_folder_id
         FROM mailboxes m
         JOIN folders f ON m.folder_id = f.folder_id
         WHERE m.thread_id = $1 
         AND m.user_id = $2
         AND f.type = 'archive'`,
        [threadId, userId]
      );
  
      if (checkResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ 
          error: "Archived thread not found or unauthorized.",
          details: {
            suggestion: "Check if the thread exists and is in your Archive folder"
          }
        });
      }
  
      // 4. Track restoration statistics
      const restorationStats = {
        toInbox: 0,
        toSent: 0,
        toDrafts: 0
      };
  
      // 5. Restore each message to its original folder
      for (const row of checkResult.rows) {
        const isSentByUser = row.from_email === userEmail;
        const messageType = row.message_type?.toLowerCase();
        
        let originalFolder = 'Inbox';
        let folderType = 'inbox';
        let folderId = folderMap.inbox;
  
        if (messageType === 'sent' || isSentByUser) {
          originalFolder = 'Sent';
          folderType = 'sent';
          folderId = folderMap.sent;
          restorationStats.toSent++;
        } else if (messageType === 'draft') {
          originalFolder = 'Drafts';
          folderType = 'drafts';
          folderId = folderMap.drafts;
          restorationStats.toDrafts++;
        } else {
          restorationStats.toInbox++;
        }
  
        await client.query(
          `UPDATE mailboxes 
           SET folder = $3, folder_id = $4
           WHERE id = $1 AND user_id = $2`,
          [row.id, userId, originalFolder, folderId]
        );
      }
  
      await client.query('COMMIT');
      
      res.status(200).json({ 
        success: true,
        message: "Thread restored from Archive successfully.",
        data: {
          threadId,
          restorationStats,
          emailsRestored: checkResult.rowCount,
          previousFolder: 'Archive',
          folderMapping: {
            inbox: folderMap.inbox,
            sent: folderMap.sent,
            drafts: folderMap.drafts
          }
        }
      });
  
    } catch (error) {
      await client.query('ROLLBACK');
      console.error("Error restoring thread from archive:", error);
      res.status(500).json({ 
        error: "Failed to restore thread from Archive.",
        details: process.env.NODE_ENV === 'development' ? {
          message: error.message,
          stack: error.stack
        } : undefined
      });
    } finally {
      client.release();
    }
  };

const toggleEmailStarred = async (req, res) => {
  const messageId = req.params.messageId;
  const userEmail = req.user.email; // Assuming JWT middleware sets req.user

  try {
      // First get the current starred status
      const currentStatus = await pool.query(
          `SELECT is_starred FROM mailboxes 
           WHERE message_id = $1 AND (to_email = $2 OR from_email = $2)`,
          [messageId, userEmail]
      );

      if (currentStatus.rowCount === 0) {
          return res.status(404).json({ error: "Email not found or unauthorized." });
      }

      // Determine the new status (toggle)
      const currentStarredStatus = currentStatus.rows[0].is_starred;
      const newStarredStatus = !currentStarredStatus;

      // Update with the new status
      const result = await pool.query(
          `UPDATE mailboxes 
           SET is_starred = $1 
           WHERE message_id = $2 AND (to_email = $3 OR from_email = $3)`,
          [newStarredStatus, messageId, userEmail]
      );

      res.status(200).json({ 
          success: true,
          message: `Email ${newStarredStatus ? 'starred' : 'unstarred'} successfully.`,
          data: {
              message_id: messageId,
              is_starred: newStarredStatus
          }
      });
  } catch (error) {
      console.error("Error toggling star status:", error);
      res.status(500).json({ 
          error: "Failed to toggle email star status.",
          details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
  }
};


const restoreThreadsFromArchive = async (req, res) => {
  const client = await pool.connect();
  const threadIds = req.body.threadIds;
  const userId = req.user.user_id; // Using user_id directly from auth token

  if (!threadIds || !Array.isArray(threadIds) || threadIds.length === 0) {
      await client.release();
      return res.status(400).json({ 
          error: "Invalid thread IDs",
          details: "Thread IDs array is required and must not be empty"
      });
  }

  try {
      await client.query('BEGIN');

      // 1. Get system folders for this user
      const foldersResult = await client.query(
          `SELECT folder_id, type FROM folders 
           WHERE user_id = $1 AND type IN ('inbox', 'sent', 'drafts', 'archive')`,
          [userId]
      );
      
      if (foldersResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(500).json({ 
              error: "System folders not configured",
              suggestion: "Required folders (inbox, sent, drafts, archive) not found"
          });
      }

      // Create folder mapping
      const systemFolders = foldersResult.rows.reduce((acc, row) => {
          acc[row.type] = row.folder_id;
          return acc;
      }, {});

      // Verify we have all required folders
      if (!systemFolders.archive || !systemFolders.inbox || !systemFolders.sent) {
          await client.query('ROLLBACK');
          return res.status(500).json({
              error: "Missing required system folders",
              details: {
                  archive: !!systemFolders.archive,
                  inbox: !!systemFolders.inbox,
                  sent: !!systemFolders.sent
              }
          });
      }

      // 2. Get message types for each thread
      const threadsInfo = await client.query(
          `SELECT DISTINCT ON (thread_id) 
           thread_id::text, message_type 
           FROM mailboxes 
           WHERE thread_id = ANY($1::uuid[]) 
           AND user_id = $2
           AND folder_id = $3
           ORDER BY thread_id, created_at DESC`,
          [threadIds, userId, systemFolders.archive]
      );

      const foundThreadIds = threadsInfo.rows.map(row => row.thread_id);
      const missingThreads = threadIds.filter(id => !foundThreadIds.includes(id));

      if (missingThreads.length > 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ 
              error: "Some threads not found in Archive",
              details: { missingThreads }
          });
      }

      // 3. Restore emails to original folders
      const updateResult = await client.query(
          `WITH updated_emails AS (
              UPDATE mailboxes 
              SET 
                  folder = CASE 
                      WHEN message_type = 'sent' THEN 'Sent' 
                      WHEN message_type = 'draft' THEN 'Drafts'
                      ELSE 'Inbox' 
                  END,
                  folder_id = CASE 
                      WHEN message_type = 'sent' THEN $3::integer 
                      WHEN message_type = 'draft' THEN COALESCE($4::integer, $5::integer)
                      ELSE $5::integer 
                  END
              WHERE thread_id = ANY($1::uuid[]) 
              AND user_id = $2
              AND folder_id = $6::integer
              RETURNING id, thread_id::text
           )
           SELECT thread_id, COUNT(*) as count FROM updated_emails
           GROUP BY thread_id`,
          [
              threadIds, 
              userId,
              systemFolders.sent,    // For sent messages
              systemFolders.drafts,   // For drafts (fallback to inbox if not exists)
              systemFolders.inbox,    // Default target
              systemFolders.archive   // Current archive folder
          ]
      );

      await client.query('COMMIT');
      
      res.status(200).json({ 
          success: true,
          message: "Threads restored successfully",
          data: {
              threadsProcessed: threadIds.length,
              emailsRestored: updateResult.rows.reduce((sum, row) => sum + row.count, 0),
              details: updateResult.rows.map(row => ({
                  threadId: row.thread_id,
                  emailsRestored: row.count
              })),
              timestamp: new Date().toISOString()
          }
      });

  } catch (error) {
      await client.query('ROLLBACK');
      console.error("Restoration error:", {
          message: error.message,
          stack: error.stack,
          query: error.query,
          parameters: error.parameters
      });
      
      res.status(500).json({ 
          error: "Restoration failed",
          details: process.env.NODE_ENV === 'development' ? {
              error: error.message,
              code: error.code
          } : undefined
      });
  } finally {
      client.release();
  }
};



const moveThreadsToFolder = async (req, res) => {
  const client = await pool.connect();
  const threadIds = req.body.threadIds;
  const userEmail = req.user.email;
  const toFolder = req.query.toFolder; // Get target folder from query params

  // Validate inputs
  if (!threadIds || !Array.isArray(threadIds) || threadIds.length === 0 || !userEmail) {
      return res.status(400).json({ 
          error: "Missing thread IDs or user information.",
          details: {
              threadIds: !threadIds || !Array.isArray(threadIds) || threadIds.length === 0 
                  ? "Thread IDs array is required and must not be empty" 
                  : undefined,
              userEmail: !userEmail ? "User email is required" : undefined
          }
      });
  }

  if (!toFolder) {
      return res.status(400).json({
          error: "Target folder not specified",
          details: "Please provide a 'toFolder' query parameter (e.g., ?toFolder=Spam)"
      });
  }

  try {
      await client.query('BEGIN');

      // 1. Get user ID
      const userResult = await client.query(
          `SELECT id FROM users WHERE email = $1`,
          [userEmail]
      );
      
      if (userResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: "User not found." });
      }
      
      const userId = userResult.rows[0].id;

      // 2. Get target folder ID
      const folderResult = await client.query(
          `SELECT folder_id, type FROM folders 
           WHERE user_id = $1 AND (name = $2 OR type = $2)`,
          [userId, toFolder]
      );
      
      if (folderResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ 
              error: "Target folder not found.",
              suggestion: "Check the folder name or create it first"
          });
      }
      
      const targetFolder = folderResult.rows[0];
      const targetFolderId = targetFolder.folder_id;
      const folderType = targetFolder.type;

      // 3. Verify threads exist and belong to user
      const checkResult = await client.query(
          `SELECT thread_id::text FROM mailboxes 
           WHERE thread_id = ANY($1::uuid[]) AND user_id = $2
           GROUP BY thread_id`,
          [threadIds, userId]
      );

      const foundThreadIds = checkResult.rows.map(row => row.thread_id);
      const missingThreads = threadIds.filter(id => !foundThreadIds.includes(id));

      if (missingThreads.length > 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ 
              error: "Some threads not found or unauthorized.",
              details: { missingThreads }
          });
      }

      // 4. Update emails to move to target folder
      const updateResult = await client.query(
          `UPDATE mailboxes 
           SET folder = $1, folder_id = $2
           WHERE thread_id = ANY($3::uuid[]) AND user_id = $4
           RETURNING thread_id::text, id`,
          [folderType === 'custom' ? toFolder : folderType, targetFolderId, threadIds, userId]
      );

      // Group results
      const resultsByThread = updateResult.rows.reduce((acc, row) => {
          if (!acc[row.thread_id]) {
              acc[row.thread_id] = [];
          }
          acc[row.thread_id].push(row.id);
          return acc;
      }, {});

      await client.query('COMMIT');
      
      res.status(200).json({ 
          success: true,
          message: `Threads moved to ${toFolder} successfully.`,
          data: {
              targetFolderId,
              targetFolderName: toFolder,
              threadsProcessed: threadIds.length,
              emailsUpdated: updateResult.rowCount,
              resultsByThread,
              timestamp: new Date().toISOString()
          }
      });

  } catch (error) {
      await client.query('ROLLBACK');
      console.error("Error moving threads:", {
          message: error.message,
          stack: error.stack,
          details: error.detail || 'No additional details',
          query: error.query || 'Not available'
      });
      res.status(500).json({ 
          error: `Failed to move threads to ${toFolder}.`,
          details: process.env.NODE_ENV === 'development' ? {
              message: error.message,
              databaseError: error.detail
          } : undefined
      });
  } finally {
      client.release();
  }
};


const moveMessagesToFolder = async (req, res) => {
  const client = await pool.connect();
  const messageIds = req.body.messageIds;
  const userEmail = req.user.email;
  const toFolder = req.query.toFolder; // Get target folder from query params

  // Validate inputs
  if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0 || !userEmail) {
      return res.status(400).json({ 
          error: "Missing message IDs or user information.",
          details: {
              messageIds: !messageIds || !Array.isArray(messageIds) || messageIds.length === 0 
                  ? "Message IDs array is required and must not be empty" 
                  : undefined,
              userEmail: !userEmail ? "User email is required" : undefined
          }
      });
  }

  if (!toFolder) {
      return res.status(400).json({
          error: "Target folder not specified",
          details: "Please provide a 'toFolder' query parameter (e.g., ?toFolder=Spam)"
      });
  }

  try {
      await client.query('BEGIN');

      // 1. Get user ID
      const userResult = await client.query(
          `SELECT id FROM users WHERE email = $1`,
          [userEmail]
      );
      
      if (userResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: "User not found." });
      }
      
      const userId = userResult.rows[0].id;

      // 2. Get target folder ID
      const folderResult = await client.query(
          `SELECT folder_id, type FROM folders 
           WHERE user_id = $1 AND (name = $2 OR type = $2)`,
          [userId, toFolder]
      );
      
      if (folderResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ 
              error: "Target folder not found.",
              suggestion: "Check the folder name or create it first"
          });
      }
      
      const targetFolder = folderResult.rows[0];
      const targetFolderId = targetFolder.folder_id;
      const folderType = targetFolder.type;

      // 3. Verify messages exist and belong to user
      const checkResult = await client.query(
          `SELECT message_id FROM mailboxes 
           WHERE message_id = ANY($1::text[]) AND user_id = $2`,
          [messageIds, userId]
      );

      const foundMessageIds = checkResult.rows.map(row => row.message_id);
      const missingMessages = messageIds.filter(id => !foundMessageIds.includes(id));

      if (missingMessages.length > 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ 
              error: "Some messages not found or unauthorized.",
              details: { missingMessages }
          });
      }

      // 4. Update emails to move to target folder
      const updateResult = await client.query(
          `UPDATE mailboxes 
           SET folder = $1, folder_id = $2
           WHERE message_id = ANY($3::text[]) AND user_id = $4
           RETURNING message_id, id, thread_id::text`,
          [folderType === 'custom' ? toFolder : folderType, targetFolderId, messageIds, userId]
      );

      // Group results by message_id
      const resultsByMessage = updateResult.rows.reduce((acc, row) => {
          acc[row.message_id] = {
              dbId: row.id,
              threadId: row.thread_id
          };
          return acc;
      }, {});

      await client.query('COMMIT');
      
      res.status(200).json({ 
          success: true,
          message: `Messages moved to ${toFolder} successfully.`,
          data: {
              targetFolderId,
              targetFolderName: toFolder,
              messagesProcessed: messageIds.length,
              emailsUpdated: updateResult.rowCount,
              resultsByMessage,
              timestamp: new Date().toISOString()
          }
      });

  } catch (error) {
      await client.query('ROLLBACK');
      console.error("Error moving messages:", {
          message: error.message,
          stack: error.stack,
          details: error.detail || 'No additional details',
          query: error.query || 'Not available'
      });
      res.status(500).json({ 
          error: `Failed to move messages to ${toFolder}.`,
          details: process.env.NODE_ENV === 'development' ? {
              message: error.message,
              databaseError: error.detail
          } : undefined
      });
  } finally {
      client.release();
  }
};

const restoreThreadsFromFolder = async (req, res) => {
  const client = await pool.connect();
  try {
    // Input validation
    const { threadIds } = req.body;
    const userId = req.user.user_id;
    const restoreFrom = req.query.restoreFrom;

    console.log("Restore from:", restoreFrom);

    // Validate thread IDs
    if (!threadIds || !Array.isArray(threadIds)) {
      await client.release();
      return res.status(400).json({ 
        error: "Invalid thread IDs",
        details: "Thread IDs array is required and must not be empty"
      });
    }

    // Validate UUID format
    const isValidUUID = (id) => {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
    };

    const invalidThreadIds = threadIds.filter(id => !isValidUUID(id));
    if (invalidThreadIds.length > 0) {
      await client.release();
      return res.status(400).json({
        error: "Invalid UUID format in thread IDs",
        details: `These IDs are not valid UUIDs: ${invalidThreadIds.join(', ')}`
      });
    }

    if (!restoreFrom) {
      await client.release();
      return res.status(400).json({
        error: "Source folder not specified",
        details: "Please provide a 'restoreFrom' query parameter"
      });
    }

    await client.query('BEGIN');

    // 1. Get source folder ID with explicit type conversion
    const sourceFolderResult = await client.query(
      `SELECT folder_id::integer FROM folders 
       WHERE user_id = $1 AND (name ILIKE $2 OR type ILIKE $2)`,
      [userId, restoreFrom]
    );
    
    if (sourceFolderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(404).json({ 
        error: "Source folder not found",
        suggestion: "Check the folder exists and you have permission"
      });
    }
    const sourceFolderId = parseInt(sourceFolderResult.rows[0].folder_id, 10);

    // 2. Get system folders with type safety
    const systemFoldersResult = await client.query(
      `SELECT type, folder_id::integer FROM folders 
       WHERE user_id = $1 AND type IN ('inbox', 'sent', 'drafts')`,
      [userId]
    );
    
    const systemFolders = systemFoldersResult.rows.reduce((acc, row) => {
      acc[row.type] = parseInt(row.folder_id, 10);
      return acc;
    }, {});

    if (!systemFolders.inbox || !systemFolders.sent) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(500).json({ 
        error: "System folders not configured",
        details: "Required folders (inbox/sent) not found"
      });
    }

    // 3. Restore emails with explicit type casting (updated_at removed)
    const updateResult = await client.query(
      `WITH updated_emails AS (
        UPDATE mailboxes 
        SET 
          folder = CASE 
            WHEN message_type = 'sent' THEN 'Sent'
            WHEN message_type = 'draft' THEN 'Drafts'
            ELSE 'Inbox'
          END,
          folder_id = CASE 
            WHEN message_type = 'sent' THEN $3::integer
            WHEN message_type = 'draft' THEN COALESCE($4::integer, $5::integer)
            ELSE $5::integer
          END
        WHERE thread_id = ANY($1::uuid[]) 
        AND user_id = $2::uuid
        AND folder_id = $6::integer
        RETURNING id, thread_id
      )
      SELECT thread_id, COUNT(*) as count FROM updated_emails
      GROUP BY thread_id`,
      [
        threadIds,
        userId,
        systemFolders.sent,
        systemFolders.drafts || null,
        systemFolders.inbox,
        sourceFolderId
      ]
    );

    // Verify all threads were processed
    const processedThreads = updateResult.rows.map(row => row.thread_id);
    const missingThreads = threadIds.filter(id => !processedThreads.includes(id));

    if (missingThreads.length > 0) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(404).json({ 
        error: "Some threads not found in source folder",
        details: { missingThreads }
      });
    }

    await client.query('COMMIT');
    
    res.status(200).json({ 
      success: true,
      message: `Threads restored from ${restoreFrom}`,
      data: {
        threadsProcessed: threadIds.length,
        emailsRestored: updateResult.rows.reduce((sum, row) => sum + parseInt(row.count), 0),
        restoredFrom: restoreFrom,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Restoration error:", {
      message: error.message,
      stack: error.stack,
      query: error.query,
      parameters: error.parameters,
      parameterTypes: error.parameters?.map(p => typeof p)
    });
    
    res.status(500).json({ 
      error: "Restoration failed",
      details: process.env.NODE_ENV === 'development' ? {
        error: error.message,
        code: error.code
      } : undefined
    });
  } finally {
    await client.release();
  }
};

const restoreMessagesFromFolder = async (req, res) => {
  const client = await pool.connect();
  try {
    // Input validation
    const { messageIds } = req.body;
    const userId = req.user.user_id;
    const restoreFrom = req.query.restoreFrom;

    console.log("Restore from:", restoreFrom);

    // Validate message IDs
    if (!messageIds || !Array.isArray(messageIds)) {
      await client.release();
      return res.status(400).json({ 
        error: "Invalid message IDs",
        details: "Message IDs array is required and must not be empty"
      });
    }

    if (!restoreFrom) {
      await client.release();
      return res.status(400).json({
        error: "Source folder not specified",
        details: "Please provide a 'restoreFrom' query parameter"
      });
    }

    await client.query('BEGIN');

    // 1. Get source folder ID with explicit type conversion
    const sourceFolderResult = await client.query(
      `SELECT folder_id::integer FROM folders 
       WHERE user_id = $1 AND (name ILIKE $2 OR type ILIKE $2)`,
      [userId, restoreFrom]
    );
    
    if (sourceFolderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(404).json({ 
        error: "Source folder not found",
        suggestion: "Check the folder exists and you have permission"
      });
    }
    const sourceFolderId = parseInt(sourceFolderResult.rows[0].folder_id, 10);

    // 2. Get system folders with type safety
    const systemFoldersResult = await client.query(
      `SELECT type, folder_id::integer FROM folders 
       WHERE user_id = $1 AND type IN ('inbox', 'sent', 'drafts')`,
      [userId]
    );
    
    const systemFolders = systemFoldersResult.rows.reduce((acc, row) => {
      acc[row.type] = parseInt(row.folder_id, 10);
      return acc;
    }, {});

    if (!systemFolders.inbox || !systemFolders.sent) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(500).json({ 
        error: "System folders not configured",
        details: "Required folders (inbox/sent) not found"
      });
    }

    // 3. Restore emails with explicit type casting (updated_at removed)
    const updateResult = await client.query(
      `UPDATE mailboxes 
       SET 
         folder = CASE 
           WHEN message_type = 'sent' THEN 'Sent'
           WHEN message_type = 'draft' THEN 'Drafts'
           ELSE 'Inbox'
         END,
         folder_id = CASE 
           WHEN message_type = 'sent' THEN $3::integer
           WHEN message_type = 'draft' THEN COALESCE($4::integer, $5::integer)
           ELSE $5::integer
         END
       WHERE message_id = ANY($1::text[]) 
       AND user_id = $2::uuid
       AND folder_id = $6::integer
       RETURNING id, message_id, thread_id`,
      [
        messageIds,
        userId,
        systemFolders.sent,
        systemFolders.drafts || null,
        systemFolders.inbox,
        sourceFolderId
      ]
    );

    // Verify all messages were processed
    const processedMessages = updateResult.rows.map(row => row.message_id);
    const missingMessages = messageIds.filter(id => !processedMessages.includes(id));

    if (missingMessages.length > 0) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(404).json({ 
        error: "Some messages not found in source folder",
        details: { missingMessages }
      });
    }

    await client.query('COMMIT');
    
    res.status(200).json({ 
      success: true,
      message: `Messages restored from ${restoreFrom}`,
      data: {
        messagesProcessed: messageIds.length,
        emailsRestored: updateResult.rowCount,
        restoredFrom: restoreFrom,
        results: updateResult.rows.map(row => ({
          messageId: row.message_id,
          dbId: row.id,
          threadId: row.thread_id
        })),
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Message restoration error:", {
      message: error.message,
      stack: error.stack,
      query: error.query,
      parameters: error.parameters,
      parameterTypes: error.parameters?.map(p => typeof p)
    });
    
    res.status(500).json({ 
      error: "Message restoration failed",
      details: process.env.NODE_ENV === 'development' ? {
        error: error.message,
        code: error.code
      } : undefined
    });
  } finally {
    await client.release();
  }
};


const deleteDraft = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { message_id } = req.params;
    const userId = req.user.user_id;

    // Validate user and draft ownership
    const draftResult = await client.query(
      `SELECT id FROM mailboxes 
       WHERE message_id = $1 AND user_id = $2 AND is_draft = true`,
      [message_id, userId]
    );

    if (draftResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ 
        message: "Draft not found or not owned by user" 
      });
    }

    // Delete the draft
    await client.query(
      `DELETE FROM mailboxes WHERE id = $1`,
      [draftResult.rows[0].id]
    );

    await client.query("COMMIT");
    res.status(200).json({ 
      message: "Draft deleted successfully",
      deleted_message_id: message_id
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Draft deletion error:", {
      message: err.message,
      stack: err.stack,
      params: req.params,
      user: req.user
    });
    
    res.status(500).json({
      message: "Failed to delete draft",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    client.release();
  }
};

const deleteDrafts = async (req, res) => {
  const client = await pool.connect();
  const { messageIds } = req.body;
  const userId = req.user.user_id;

  // ✅ Input validation
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    client.release();
    return res.status(400).json({
      message: "messageIds must be a non-empty array"
    });
  }

  try {
    await client.query("BEGIN");

    // ✅ Secure deletion: only delete drafts for this user
    const deleteResult = await client.query(
      `DELETE FROM mailboxes 
       WHERE message_id = ANY($1)
       AND is_draft = true
       AND user_id = $2
       RETURNING message_id`,
      [messageIds, userId]
    );

    await client.query("COMMIT");

    res.status(200).json({
      message: "Draft deletion completed",
      deleted_count: deleteResult.rowCount,
      deleted_message_ids: deleteResult.rows.map(row => row.message_id)
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Draft deletion error:", err);
    res.status(500).json({
      message: "Failed to delete drafts",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    client.release();
  }
};


module.exports = { 
          getEmails, 
          sendEmail, 
          getEmailsByThreadId, 
          moveToTrash, 
          deleteEmail, 
          setEmailIsRead, 
          setEmailStarred, 
          saveDraft, 
          moveMessageToArchive, 
          getEmailByMessageId, 
          restoreFromArchive, 
          moveThreadToArchive, 
          restoreThreadFromArchive, 
          moveThreadToTrash, 
          restoreThreadFromTrash,
          toggleEmailStarred,
          moveEmailToSpam,
          moveThreadToSpam,
          getStarredEmails,
          moveThreadsToArchive,
          restoreThreadsFromArchive,
          moveThreadsToFolder,
          moveMessagesToFolder,
          restoreMessagesFromFolder,
          restoreThreadsFromFolder,
          setThreadsReadStatus,
          deleteMultipleThreads,
          getEmailCounts,
          storeEmailInDb,
          storeEmailsInDb,
          deleteDraft,
          deleteDrafts
  };