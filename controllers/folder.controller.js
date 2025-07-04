const pool = require("../db");
const nodemailer = require("nodemailer");
const { v4: uuidv4 } = require("uuid");
const threadId = uuidv4();
const { groupBy } = require("pg");

// Get all folders for user
const getFolders = async (req, res) => {
    const { type } = req.query;
    const values = [req.user.user_id];
    let query = 'SELECT folder_id, name, type, parent_id FROM folders WHERE user_id = $1';
  
    if (type) {
      query += ' AND type = $2';
      values.push(type);
    }
  
    query += ' ORDER BY name';
  
    try {
      const result = await pool.query(query, values);
      res.json({ folders: result.rows });
    } catch (err) {
      res.status(500).json({ error: "Failed to get folders", message: err.message });
    }
  };
  
  
  // Create new folder
  const createFolder = async (req, res) => {
    try {
      const {
        name,
        type = 'custom',  // Default to 'custom' if not provided
        parent_id = null, // Default to null if not provided
        color = null,
        icon = null,
        sort_order = 0,
        sync_enabled = true
      } = req.body;
  
      const user_id = req.user.user_id;
  
      // Validate required fields
      if (!name) {
        return res.status(400).json({ error: "Folder name is required" });
      }
  
      // Validate folder type
      const validTypes = ['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive', 'custom'];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ 
          error: "Invalid folder type",
          validTypes
        });
      }
  
      // Validate color format if provided
      if (color && !/^#[0-9A-F]{6}$/i.test(color)) {
        return res.status(400).json({ 
          error: "Invalid color format. Use hex format (#RRGGBB)"
        });
      }
  
      // Check if parent folder exists and belongs to user
      if (parent_id) {
        const parentCheck = await pool.query(
          'SELECT 1 FROM folders WHERE folder_id = $1 AND user_id = $2',
          [parent_id, user_id]
        );
        if (parentCheck.rowCount === 0) {
          return res.status(400).json({ 
            error: "Parent folder not found or doesn't belong to user"
          });
        }
      }
  
      // Create the folder
      const result = await pool.query(
        `INSERT INTO folders (
          user_id,
          name,
          type,
          parent_id,
          color,
          icon,
          sort_order,
          sync_enabled
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
        RETURNING *`,
        [
          user_id,
          name,
          type,
          parent_id,
          color,
          icon,
          sort_order,
          sync_enabled
        ]
      );
  
      res.status(201).json({ 
        success: true,
        folder: result.rows[0],
        message: "Folder created successfully"
      });
  
    } catch (err) {
      console.error("Error creating folder:", err);
      
      if (err.code === '23505') { // Unique violation
        res.status(400).json({ 
          error: "Folder name already exists for this user",
          suggestion: "Choose a different folder name"
        });
      } else if (err.code === '23503') { // Foreign key violation
        res.status(400).json({ 
          error: "Invalid parent folder reference",
          details: "The specified parent folder doesn't exist"
        });
      } else {
        res.status(500).json({ 
          error: "Failed to create folder",
          details: process.env.NODE_ENV === 'development' ? {
            message: err.message,
            code: err.code
          } : undefined
        });
      }
    }
  };
  
  const getFolderByName = async (req, res) => {
    try {
      const folderName = req.params.name; // Get folder name from URL params
      
      // Validate folder name
      if (!folderName || typeof folderName !== 'string') {
        return res.status(400).json({ error: "Invalid folder name" });
      }
  
      const result = await pool.query(
        `SELECT 
          folder_id as id, 
          name, 
          type, 
          color, 
          icon,
          parent_id,
          sort_order,
          sync_enabled
         FROM folders 
         WHERE user_id = $1 AND name = $2`,
        [req.user.user_id, folderName]
      );
  
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Folder not found" });
      }
  
      res.json({ folder: result.rows[0] });
  
    } catch (err) {
      console.error("Error fetching folder:", err);
      res.status(500).json({ 
        error: "Failed to get folder",
        details:err.message 
      });
    }
  };
  
  // Move email to folder
  const moveToFolder = async (req, res) => {
    try {
      const { message_id, folder_name } = req.body;
      await pool.query(
        'UPDATE mailboxes SET folder = $1 WHERE message_id = $2 AND user_id = $3',
        [folder_name, message_id, req.user.user_id]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to move email" });
    }
  };


  // Search folders by name or type with pagination
  const searchFolders = async (req, res) => {
    try {
      const { query, limit = 10, offset = 0 } = req.query;
      const userId = req.user.user_id;
  
      // Initialize base query
      let baseQuery = 'SELECT folder_id as id, name, type, color, icon, parent_id FROM folders WHERE user_id = $1';
      const values = [userId];
      let paramCount = 2;
  
      // --- Flexible name filtering (case-insensitive match) ---
      if (typeof query === 'string' && query.trim() !== '') {
        baseQuery += ` AND name ILIKE $${paramCount}`;
        values.push(`%${query.trim()}%`);
        paramCount++;
      }
  
      // --- Pagination ---
      baseQuery += ` ORDER BY name LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
      values.push(parseInt(limit, 10), parseInt(offset, 10));
  
      const countQuery = baseQuery
        .replace(/SELECT .*? FROM/, 'SELECT COUNT(*) FROM')
        .replace(/ORDER BY.*/, '');
  
      const [result, countResult] = await Promise.all([
        pool.query(baseQuery, values),
        pool.query(countQuery, values.slice(0, -2))
      ]);
  
      return res.json({
        success: true,
        folders: result.rows,
        meta: {
          total: parseInt(countResult.rows[0].count, 10),
          limit: parseInt(limit, 10),
          offset: parseInt(offset, 10)
        }
      });
  
    } catch (err) {
      console.error("Error searching folders:", err);
      res.status(500).json({
        error: "Failed to search folders",
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  };
  
  
  

// Get folder suggestions for typeahead/search dropdown
const getFolderSuggestions = async (req, res) => {
  try {
      const { query, excludeTypes = [] } = req.query;
      const userId = req.user.user_id;

      if (!query || query.length < 2) {
          return res.status(400).json({ 
              error: "Search query must be at least 2 characters long" 
          });
      }

      let baseQuery = `
          SELECT 
              folder_id as id, 
              name, 
              type,
              parent_id,
              CASE 
                  WHEN type = 'inbox' THEN 1
                  WHEN type = 'sent' THEN 2
                  WHEN type = 'drafts' THEN 3
                  ELSE 4
              END as priority
          FROM folders 
          WHERE user_id = $1 AND name ILIKE $2
      `;
      
      const values = [userId, `%${query}%`];
      
      // Add type exclusion if needed
      if (excludeTypes.length > 0) {
          const placeholders = excludeTypes.map((_, i) => `$${i + 3}`).join(',');
          baseQuery += ` AND type NOT IN (${placeholders})`;
          values.push(...excludeTypes);
      }

      baseQuery += ' ORDER BY priority, name LIMIT 10';

      const result = await pool.query(baseQuery, values);

      res.json({
          success: true,
          suggestions: result.rows
      });

  } catch (err) {
      console.error("Error getting folder suggestions:", err);
      res.status(500).json({ 
          error: "Failed to get folder suggestions",
          details: err.message 
      });
  }
};

const editFolder = async (req, res) => {
  try {
    const { id } = req.params; // From route params
    const { name } = req.body;
    const user_id = req.user.user_id;

    if (!id || !name) {
      return res.status(400).json({
        error: "Both folder_id and name are required"
      });
    }

    const folderCheck = await pool.query(
      `SELECT * FROM folders WHERE folder_id = $1 AND user_id = $2`,
      [id, user_id]
    );

    if (folderCheck.rowCount === 0) {
      return res.status(404).json({
        error: "Folder not found or doesn't belong to user"
      });
    }

    const folder = folderCheck.rows[0];

    if (folder.type !== 'custom') {
      return res.status(403).json({
        error: "Only custom folders can be renamed"
      });
    }

    const result = await pool.query(
      `UPDATE folders
       SET name = $1, updated_at = NOW()
       WHERE folder_id = $2 AND user_id = $3
       RETURNING *`,
      [name, id, user_id]
    );

    res.status(200).json({
      success: true,
      // folder: result.rows[0],
      message: "Folder name updated successfully"
    });

  } catch (err) {
    console.error("Error updating folder name:", err);

    if (err.code === '23505') {
      res.status(400).json({
        error: "Folder name already exists for this user",
        suggestion: "Choose a different folder name"
      });
    } else {
      res.status(500).json({
        error: "Failed to update folder name",
        details: process.env.NODE_ENV === 'development' ? {
          message: err.message,
          code: err.code
        } : undefined
      });
    }
  }
};

const deleteFolder = async (req, res) => {
  try {
    const { id } = req.params;
    const user_id = req.user.user_id;

    if (!id) {
      return res.status(400).json({
        error: "folder_id is required"
      });
    }

    // Check if folder exists and belongs to user
    const folderCheck = await pool.query(
      `SELECT * FROM folders WHERE folder_id = $1 AND user_id = $2`,
      [id, user_id]
    );

    if (folderCheck.rowCount === 0) {
      return res.status(404).json({
        error: "Folder not found or doesn't belong to user"
      });
    }

    const folder = folderCheck.rows[0];

    // Only allow deleting custom folders
    if (folder.type !== 'custom') {
      return res.status(403).json({
        error: "Only custom folders can be deleted"
      });
    }

    // Permanently delete the folder
    await pool.query(
      `DELETE FROM folders WHERE folder_id = $1 AND user_id = $2`,
      [id, user_id]
    );

    res.status(200).json({
      success: true,
      message: "Folder permanently deleted"
    });

  } catch (err) {
    console.error("Error deleting folder:", err);
    res.status(500).json({
      error: "Failed to permanently delete folder",
      details: process.env.NODE_ENV === 'development' ? {
        message: err.message,
        code: err.code
      } : undefined
    });
  }
};



  module.exports = {  getFolders,
    getFolderByName,
    createFolder,
    moveToFolder,
    searchFolders,
    getFolderSuggestions,
    editFolder,
    deleteFolder
  }