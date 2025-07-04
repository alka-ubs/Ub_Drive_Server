const { v4: uuidv4 } = require('uuid');
const pool = require('../db');

const createFolder = async (req, res) => {
  try {
    const { name, parent_id, location = 'my_drive' } = req.body;
    const userId = req.user.user_id;
    const folderId = uuidv4();

    if (!name) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    const result = await pool.query(
      `INSERT INTO driveFolders (
        id, 
        name, 
        user_id,
        parent_id,
        location,
        created_at,
        updated_at
       ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id, name, parent_id, location, created_at`,
      [folderId, name, userId, parent_id || null, location]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create folder error:', error);
    return res.status(500).json({ 
      error: 'Failed to create folder',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};


const uploadFolderStructure = async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { structure, parentId = null, location = 'my_drive' } = req.body;
    const userId = req.user.user_id;

    // Validate input
    if (!structure || typeof structure !== 'object') {
      return res.status(400).json({ error: 'Invalid folder structure' });
    }

    if (!['my_drive', 'shared'].includes(location)) {
      return res.status(400).json({ error: 'Invalid location value' });
    }

    await client.query('BEGIN');

    // Process the entire structure
    const result = await processFolderStructure(
      client,
      structure,
      userId,
      parentId,
      location
    );

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      data: result
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Folder upload error:', error);
    return res.status(500).json({ 
      error: 'Folder upload failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
};


async function processFolderStructure(client, structure, userId, parentId, location) {
  const folderId = uuidv4();
  const now = new Date();

  // Insert current folder
  await client.query(
    `INSERT INTO driveFolders (
      id, name, user_id, parent_id, location,
      created_at, updated_at, sort_order, is_trashed
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      folderId,
      structure.name,
      userId,
      parentId,
      location,
      now,
      now,
      structure.sortOrder || 0,
      false
    ]
  );

  const response = {
    id: folderId,
    name: structure.name,
    parentId,
    location,
    createdAt: now,
    updatedAt: now,
    children: []
  };

  // Process children if they exist
  if (structure.children && structure.children.length > 0) {
    for (const child of structure.children) {
      const childResult = await processFolderStructure(
        client,
        child,
        userId,
        folderId, 
        location
      );
      response.children.push(childResult);
    }
  }

  return response;
}

const getAllFolders = async (req, res) => {
  try {
    const userId = req.user.user_id;

    const result = await pool.query(
      `SELECT 
        f.id,
        f.name,
        f.parent_id,
        f.user_id,
        f.location,
        f.created_at,
        f.updated_at,
        f.is_trashed,
        f.trashed_at,
        f.is_system,
        f.sort_order,
        f.type,
        json_build_object(
          'id', u.id,
          'email', u.email,
          'username', u.username
        ) as owner,
        (SELECT COUNT(*) FROM driveFolders WHERE parent_id = f.id) as subfolder_count,
        (SELECT COUNT(*) FROM files WHERE parent_id = f.id) as file_count
       FROM driveFolders f
       JOIN users u ON f.user_id = u.id
       WHERE f.user_id = $1 AND f.is_trashed = false
       ORDER BY f.sort_order ASC, f.created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get all folders error:', error);
    res.status(500).json({
      error: 'Failed to fetch folders',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const getFolderContents = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.user_id;

    const folder = await pool.query(
      `SELECT 
        id, 
        name, 
        parent_id, 
        created_at, 
        location,
        is_trashed, 
        trashed_at,
        sort_order
       FROM driveFolders
       WHERE id = $1 AND user_id = $2 AND is_trashed = false`,
      [id, userId]
    );

    if (folder.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found or access denied' });
    }

    return res.json(folder.rows[0]);
  } catch (error) {
    console.error('Get folder contents error:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch folder',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const renameFolder = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    const userId = req.user.user_id;

    if (!name) {
      return res.status(400).json({ error: 'New folder name is required' });
    }

    const result = await pool.query(
      `UPDATE driveFolders
       SET name = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3
       RETURNING id, name, parent_id, created_at, location, sort_order`,
      [name, id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found or access denied' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Rename folder error:', error);
    return res.status(500).json({ 
      error: 'Failed to rename folder',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const deleteFolder = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.user_id;
    const folderCheck = await pool.query(
      `SELECT id FROM driveFolders WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (folderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found or access denied' });
    }
    const result = await pool.query(
      `DELETE FROM driveFolders
       WHERE id = $1
       RETURNING id, name, location`,
      [id]
    );

    return res.json({ 
      message: 'Folder permanently deleted',
    });
  } catch (error) {
    console.error('Delete folder error:', error);
    return res.status(500).json({ 
      error: 'Failed to delete folder',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};


const updateFolderState = async (req, res) => {
  try {
    const { id, field, value } = req.params;
    const userId = req.user.user_id;

    // Validate field
    const validFields = ['is_starred', 'is_trashed', 'is_archived'];
    if (!validFields.includes(field)) {
      return res.status(400).json({ 
        error: 'Invalid field',
        valid_fields: validFields
      });
    }

    // Convert string to boolean
    const boolValue = value.toLowerCase() === 'true';

    // Only update the boolean field (no timestamp updates)
    const query = `
      UPDATE drivefolders 
      SET ${field} = $1
      WHERE id = $2 AND user_id = $3
      RETURNING *
    `;

    const result = await pool.query(query, [boolValue, id, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Folder not found or not owned by user'
      });
    }

    res.json({
      success: true,
      folder: result.rows[0]
    });

  } catch (err) {
    console.error('Update folder error:', err);
    res.status(500).json({ 
      error: 'Server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

const permanentDeleteFolder = async (req, res) => {
  const client = await pool.connect();
  try {
    const { folderId } = req.params;
    const userId = req.user.user_id;

    // 1. Validate folder ID
    if (!isValidUUID(folderId)) {
      return res.status(400).json({ error: 'Invalid folder ID format' });
    }

    await client.query('BEGIN');

    // 2. Get folder record with verification of ownership
    const { rows: [folder] } = await client.query(
      `SELECT id, storage_path 
       FROM drivefolders 
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`, // Lock the row
      [folderId, userId]
    );

    if (!folder) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Folder not found or no permission' });
    }

    // 3. Get all files in folder to calculate total size
    const { rows: files } = await client.query(
      `SELECT id, storage_path, size 
       FROM files 
       WHERE parent_id = $1`,
      [folderId]
    );

    // 4. Delete all files physically
    const storageRoot = process.env.STORAGE_ROOT;
    let totalFreedSpace = 0;
    
    for (const file of files) {
      try {
        const fullPath = path.join(storageRoot, file.storage_path);
        fs.unlinkSync(fullPath);
        totalFreedSpace += parseInt(file.size);
      } catch (err) {
        console.error(`Error deleting file ${file.id}:`, err);
        // Continue with other files even if one fails
      }
    }

    // 5. Delete folder physically (if it has storage_path)
    if (folder.storage_path) {
      try {
        const folderPath = path.join(storageRoot, folder.storage_path);
        await rimraf(folderPath); // Recursive delete
      } catch (err) {
        console.error('Folder deletion error:', err);
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'Failed to delete folder from storage' });
      }
    }

    // 6. Delete all files from database
    await client.query(
      'DELETE FROM files WHERE parent_id = $1',
      [folderId]
    );

    // 7. Delete folder from database
    await client.query(
      'DELETE FROM drivefolders WHERE id = $1',
      [folderId]
    );

    // 8. Update user storage
    if (totalFreedSpace > 0) {
      await client.query(
        'UPDATE users SET used_storage = used_storage - $1 WHERE id = $2',
        [totalFreedSpace, userId]
      );
    }

    await client.query('COMMIT');
    
    return res.status(200).json({ 
      success: true,
      message: 'Folder and all contents permanently deleted',
      freedSpace: totalFreedSpace,
      deletedFiles: files.length
    });

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Permanent folder delete error:', error);
    return res.status(500).json({ 
      error: 'Permanent folder deletion failed',
      ...(process.env.NODE_ENV === 'development' && { details: error.message })
    });
  } finally {
    client.release();
  }
};
module.exports = {
  createFolder,
  uploadFolderStructure,
  getAllFolders,
  getFolderContents,
  renameFolder,
  deleteFolder,
  updateFolderState,
  permanentDeleteFolder
};