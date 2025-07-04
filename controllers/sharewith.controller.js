const pool = require('../db');

/**
 * Share a file/folder with another user
 * POST /api/shares
 */
const shareItem = async (req, res) => {
  try {
    const { file_id, user_id, permission } = req.body;
    const owner_id = req.user.user_id;

    // Validate input
    if (!file_id || !user_id || !permission) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: 'file_id, user_id, and permission are required'
      });
    }

    // Validate permission type
    const validPermissions = ['view', 'edit', 'comment'];
    if (!validPermissions.includes(permission)) {
      return res.status(400).json({ 
        error: 'Invalid permission type',
        details: `Permission must be one of: ${validPermissions.join(', ')}`
      });
    }

    // Verify the file exists and is owned by the requester
    const file = await pool.query(
      `SELECT id, type FROM files 
       WHERE id = $1 AND owner_id = $2 AND trashed = false`,
      [file_id, owner_id]
    );

    if (file.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Resource not found',
        details: 'File/folder not found or not owned by you'
      });
    }

    // Verify the target user exists and is not the owner
    if (user_id === owner_id) {
      return res.status(400).json({
        error: 'Invalid share',
        details: 'Cannot share with yourself'
      });
    }

    const user = await pool.query(
      'SELECT id FROM users WHERE id = $1',
      [user_id]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({ 
        error: 'User not found',
        details: 'The specified user does not exist'
      });
    }

    // Check if share already exists
    const existingShare = await pool.query(
      'SELECT id FROM shares WHERE file_id = $1 AND user_id = $2',
      [file_id, user_id]
    );

    if (existingShare.rows.length > 0) {
      return res.status(409).json({ 
        error: 'Share exists',
        details: 'This item is already shared with the specified user'
      });
    }

    // Create the share
    const newShare = await pool.query(
      `INSERT INTO shares (
        file_id, user_id, permission, shared_by
      ) VALUES ($1, $2, $3, $4)
      RETURNING id, file_id, user_id, permission, created_at`,
      [file_id, user_id, permission, owner_id]
    );

    // Return the created share with additional details
    const result = await pool.query(
      `SELECT 
        s.id, s.permission, s.created_at,
        f.name as file_name, f.type as file_type,
        u1.username as shared_with_username,
        u2.username as shared_by_username
       FROM shares s
       JOIN files f ON s.file_id = f.id
       JOIN users u1 ON s.user_id = u1.id
       JOIN users u2 ON s.shared_by = u2.id
       WHERE s.id = $1`,
      [newShare.rows[0].id]
    );

    res.status(201).json({
      message: 'Item shared successfully',
      share: result.rows[0]
    });
  } catch (error) {
    console.error('Share item error:', error);
    res.status(500).json({ 
      error: 'Failed to share item',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * List items shared with the current user
 * GET /api/shares
 */
const listSharedItems = async (req, res) => {
  try {
    const user_id = req.user.user_id;
    const { type, permission } = req.query;

    // Base query
    let query = `
      SELECT 
        s.id as share_id,
        s.permission,
        s.created_at as shared_at,
        f.id as file_id,
        f.name,
        f.type,
        f.size,
        f.created_at,
        f.updated_at,
        json_build_object(
          'id', u.id,
          'username', u.username,
          'email', u.email,
          'avatar', u.avatar
        ) as shared_by
      FROM shares s
      JOIN files f ON s.file_id = f.id
      JOIN users u ON s.shared_by = u.id
      WHERE s.user_id = $1 AND f.trashed = false
    `;

    const params = [user_id];

    // Add filters if provided
    if (type) {
      query += ` AND f.type = $${params.length + 1}`;
      params.push(type);
    }

    if (permission) {
      query += ` AND s.permission = $${params.length + 1}`;
      params.push(permission);
    }

    // Add sorting
    query += ` ORDER BY s.created_at DESC`;

    const sharedItems = await pool.query(query, params);

    res.json({
      count: sharedItems.rows.length,
      items: sharedItems.rows
    });
  } catch (error) {
    console.error('List shared items error:', error);
    res.status(500).json({ 
      error: 'Failed to list shared items',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Get details about a specific share
 * GET /api/shares/:id
 */
const getShareDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const user_id = req.user.user_id;

    const shareDetails = await pool.query(
      `SELECT 
        s.id,
        s.permission,
        s.created_at,
        f.id as file_id,
        f.name as file_name,
        f.type as file_type,
        f.size as file_size,
        json_build_object(
          'id', u1.id,
          'username', u1.username,
          'email', u1.email,
          'avatar', u1.avatar
        ) as shared_with,
        json_build_object(
          'id', u2.id,
          'username', u2.username,
          'email', u2.email,
          'avatar', u2.avatar
        ) as shared_by
       FROM shares s
       JOIN files f ON s.file_id = f.id
       JOIN users u1 ON s.user_id = u1.id
       JOIN users u2 ON s.shared_by = u2.id
       WHERE s.id = $1 AND (s.user_id = $2 OR s.shared_by = $2)`,
      [id, user_id]
    );

    if (shareDetails.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Share not found',
        details: 'The specified share does not exist or you do not have access'
      });
    }

    res.json(shareDetails.rows[0]);
  } catch (error) {
    console.error('Get share details error:', error);
    res.status(500).json({ 
      error: 'Failed to get share details',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Update share permissions
 * PUT /api/shares/:id
 */
const updateSharePermissions = async (req, res) => {
  try {
    const { id } = req.params;
    const { permission } = req.body;
    const user_id = req.user.user_id;

    if (!permission) {
      return res.status(400).json({ 
        error: 'Missing permission',
        details: 'Permission field is required'
      });
    }

    const validPermissions = ['view', 'edit', 'comment'];
    if (!validPermissions.includes(permission)) {
      return res.status(400).json({ 
        error: 'Invalid permission',
        details: `Permission must be one of: ${validPermissions.join(', ')}`
      });
    }

    const updatedShare = await pool.query(
      `UPDATE shares SET
        permission = $1,
        updated_at = NOW()
       WHERE id = $2 AND shared_by = $3
       RETURNING id, file_id, user_id, permission`,
      [permission, id, user_id]
    );

    if (updatedShare.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Share not found',
        details: 'The specified share does not exist or you are not the owner'
      });
    }

    res.json({
      message: 'Share permissions updated successfully',
      share: updatedShare.rows[0]
    });
  } catch (error) {
    console.error('Update share permissions error:', error);
    res.status(500).json({ 
      error: 'Failed to update share permissions',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Remove a share
 * DELETE /api/shares/:id
 */
const removeShare = async (req, res) => {
  try {
    const { id } = req.params;
    const user_id = req.user.user_id;

    // First verify the share exists and user has permission
    const share = await pool.query(
      `SELECT s.id, f.owner_id, s.shared_by, s.user_id
       FROM shares s
       JOIN files f ON s.file_id = f.id
       WHERE s.id = $1 AND (s.shared_by = $2 OR s.user_id = $2 OR f.owner_id = $2)`,
      [id, user_id]
    );

    if (share.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Share not found',
        details: 'The specified share does not exist or you do not have permission'
      });
    }

    // Delete the share
    await pool.query(
      'DELETE FROM shares WHERE id = $1',
      [id]
    );

    res.json({ 
      message: 'Share removed successfully',
      share_id: id
    });
  } catch (error) {
    console.error('Remove share error:', error);
    res.status(500).json({ 
      error: 'Failed to remove share',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  shareItem,
  listSharedItems,
  getShareDetails,
  updateSharePermissions,
  removeShare
};