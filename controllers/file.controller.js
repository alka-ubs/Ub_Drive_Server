const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const { promisify } = require('util');
const copyFileAsync = promisify(fs.copyFile);
const mkdirAsync = promisify(fs.mkdir);

// Validate UUID format
const isValidUUID = (str) => {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
};

// Save file to disk
const storeFile = (buffer, userId, fileId) => {
  const uploadDir = path.join(__dirname, '../../uploads', userId.toString());
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  const filePath = path.join(uploadDir, fileId);
  fs.writeFileSync(filePath, buffer);
  return filePath;
};

// const uploadFile = async (req, res) => {
//   try {
//     // 1. Extract metadata from form-data
//     const {
//       name,
//       type = 'application/octet-stream',
//       parentId = null,
//       id: incomingId,
//       iv,
//       encryptedAesKey,
//       shared_status = 'drive'
//     } = req.body;

//     const file = req.file;
//     const userId = req.user?.user_id;

//     // 2. Validate input
//     if (!name || typeof name !== 'string') {
//       return res.status(400).json({ error: 'Invalid file name' });
//     }

//     if (!file || !file.buffer) {
//       return res.status(400).json({ error: 'No file data provided' });
//     }

//     if (!userId || !isValidUUID(userId)) {
//       return res.status(400).json({ error: 'Invalid user ID' });
//     }

//     if (!iv || !encryptedAesKey) {
//       return res.status(400).json({ error: 'Missing encryption metadata (iv or encryptedAesKey)' });
//     }

//     // 3. Assign a file ID
//     const fileId = incomingId && isValidUUID(incomingId) ? incomingId : uuidv4();

//     // 4. Check user's storage usage
//     const { rows: [user] } = await pool.query(
//       `SELECT 
//         used_storage,
//         storage_limit
//        FROM users WHERE id = $1`,
//       [userId]
//     );

//     if (!user) {
//       return res.status(404).json({ error: 'User not found' });
//     }

//     if (parseInt(user.used_storage )+ parseInt(file.size) > parseInt(user.storage_limit)) {
//       console.log({ "Used_Storage" :user.used_storage, "Total_Storagge": user.storage_limit, "File_Size": file.size}, "Storage Check");
  
//       return res.status(403).json({ error: 'Storage quota exceeded' });
//     }

//     // 5. Store encrypted file blob
//     const filePath = storeFile(file.buffer, userId, fileId); // raw encrypted blob

//     // 6. Insert metadata into DB inside transaction
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const { rows: [fileRecord] } = await client.query(
//         `INSERT INTO files (
//           id, name, type, mime_type, size,
//           parent_id, owner_id, storage_path,
//           iv, encrypted_aes_key,
//           shared_status
//         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
//         RETURNING *`,
//         [
//           fileId,
//           name,
//           'file',
//           type,
//           file.size,
//           parentId,
//           userId,
//           filePath,
//           iv,
//           encryptedAesKey,
//           shared_status
//         ]
//       );

//       await client.query(
//         'UPDATE users SET used_storage = used_storage + $1 WHERE id = $2',
//         [file.size, userId]
//       );

//       await client.query('COMMIT');
//       return res.status(201).json(fileRecord);
//     } catch (dbError) {
//       await client.query('ROLLBACK');
//       throw dbError;
//     } finally {
//       client.release();
//     }
//   } catch (error) {
//     console.error('Upload error:', error);
//     return res.status(500).json({
//       error: 'File upload failed',
//       ...(process.env.NODE_ENV === 'development' && { details: error.message })
//     });
//   }
// };

const uploadFile = async (req, res) => {
  const client = await pool.connect();
  try {
    // 1. Extract metadata from form-data
    const {
      name,
      type = 'application/octet-stream',
      parentId = null,
      id: incomingId,
      iv,
      encryptedAesKey,
      shared_status = 'drive'
    } = req.body;

    // Get folderId from params if exists
    const { folderId } = req.params;
    const file = req.file;
    const userId = req.user?.user_id;

    // 2. Validate required fields
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Invalid file name' });
    }
    if (!file || !file.buffer) {
      return res.status(400).json({ error: 'No file data provided' });
    }
    if (!userId || !isValidUUID(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    if (!iv || !encryptedAesKey) {
      return res.status(400).json({ error: 'Missing encryption metadata' });
    }

    // 3. Resolve parent ID
    const finalParentId = folderId || parentId || null;

    // Validate ID format if provided
    if (finalParentId && !isValidUUID(finalParentId)) {
      return res.status(400).json({ error: 'Invalid folder ID format' });
    }

    // 4. Check folder existence if ID provided (using user_id)
    if (finalParentId) {
      const folderCheck = await client.query(
        `SELECT id FROM drivefolders 
         WHERE id = $1 AND user_id = $2`,
        [finalParentId, userId]
      );
      
      if (folderCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Folder not found or no access' });
      }
    }

    // 5. Continue with upload logic
    const fileId = incomingId && isValidUUID(incomingId) ? incomingId : uuidv4();

    // Storage check
    const { rows: [user] } = await client.query(
      `SELECT used_storage, storage_limit FROM users WHERE id = $1`,
      [userId]
    );

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (parseInt(user.used_storage) + file.size > parseInt(user.storage_limit)) {
      return res.status(403).json({ error: 'Storage quota exceeded' });
    }

    // File storage
    const filePath = storeFile(file.buffer, userId, fileId);

    // DB transaction
    await client.query('BEGIN');

    // Insert file record (using owner_id for files table)
    const { rows: [fileRecord] } = await client.query(
      `INSERT INTO files (
        id, name, type, mime_type, size,
        parent_id, owner_id, storage_path,
        iv, encrypted_aes_key,
        shared_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        fileId,
        name,
        'file',
        type,
        file.size,
        finalParentId,
        userId, // owner_id for files table
        filePath,
        iv,
        encryptedAesKey,
        shared_status
      ]
    );

    // Update user storage
    await client.query(
      'UPDATE users SET used_storage = used_storage + $1 WHERE id = $2',
      [file.size, userId]
    );

    await client.query('COMMIT');
    return res.status(201).json(fileRecord);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Upload error:', error);
    
    // Handle specific database errors
    if (error.code === '42703') { // Undefined column error
      return res.status(500).json({ 
        error: 'Database configuration error',
        details: 'Please check your database schema'
      });
    }
    
    return res.status(500).json({
      error: 'File upload failed',
      ...(process.env.NODE_ENV === 'development' && { details: error.message })
    });
  } finally {
    client.release();
  }
};




const getFiles = async (req, res) => {
  try {
    const { parentId } = req.query;
    const userId = req.user.user_id;

    const query = `
      SELECT 
        f.id, 
        f.name, 
        f.type,
        f.mime_type,
        f.size, 
        f.parent_id,
        f.storage_path,
        f.encrypted,
        f.iv,
        f.encrypted_aes_key,
        f.created_at, 
        f.updated_at,
        f.is_starred,
        f.last_starred_at,
        f.is_trashed,
        f.trashed_at,
        f.is_archived,
        f.archived_at,
        f.importance_score,
        f.path,
        f.shared_status,
        json_build_object(
          'id', u.id,
          'email', u.email,
          'username', u.username,
          'avatar', u.avatar,
          'storage_limit', u.storage_limit,
          'used_storage', u.used_storage
        ) as owner
      FROM files f
      JOIN users u ON f.owner_id = u.id
      WHERE f.owner_id = $1 AND f.is_trashed = false
      ${parentId ? 'AND f.parent_id = $2' : 'AND f.parent_id IS NULL'}
      ORDER BY 
        CASE WHEN f.type = 'folder' THEN 0 ELSE 1 END,  -- Folders first
        f.name ASC
    `;
    const params = parentId ? [userId, parentId] : [userId];

    const result = await pool.query(query, params);
    return res.json(result.rows);
  } catch (error) {
    console.error('Get files error:', error);
    return res.status(500).json({ 
      error: 'Failed to get files',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};


const getFileContent = async (req, res) => {
  try {
    // Debug the incoming request
    console.log('Request params:', req.params);
    console.log('Request URL:', req.originalUrl);

    const { fileId } = req.params;
    const userId = req.user.user_id;

    if (!fileId) {
      return res.status(400).json({
        error: 'Bad Request',
        details: 'File ID parameter is missing from the URL'
      });
    }

    console.log(`Attempting to fetch file ${fileId} for user ${userId}`);

    const fileResult = await pool.query(
      `SELECT 
        f.*,
        json_build_object(
          'id', u.id,
          'email', u.email,
          'username', u.username,
          'avatar', u.avatar
        ) as owner
       FROM files f
       JOIN users u ON f.owner_id = u.id
       WHERE f.id = $1 AND f.is_trashed = false`,
      [fileId]
    );

    console.log(`Found ${fileResult.rows.length} matching files`);

    if (fileResult.rows.length === 0) {
      // Check if file exists but is trashed or belongs to another user
      const exists = await pool.query(
        'SELECT owner_id, is_trashed FROM files WHERE id = $1',
        [fileId]
      );
      
      if (exists.rows.length > 0) {
        if (exists.rows[0].is_trashed) {
          return res.status(404).json({ 
            error: 'File not found',
            details: 'File has been moved to trash'
          });
        }
        if (exists.rows[0].owner_id !== userId) {
          return res.status(403).json({
            error: 'Access denied',
            details: 'You do not own this file'
          });
        }
      }
      
      return res.status(404).json({ 
        error: 'File not found',
        details: `No file found with ID: ${fileId}`
      });
    }

    const file = fileResult.rows[0];
    console.log("File owner:", file.owner_id, "Requesting user:", userId);

    // Handle folder case
    if (file.type === 'folder') {
      return res.json({
        ...file,
        content: null
      });
    }

    // Verify file exists in storage
    try {
      await fs.promises.access(path.join(STORAGE_PATH, file.storage_path));
    } catch (err) {
      console.error('File missing from storage:', err);
      return res.status(404).json({ 
        error: 'File content missing',
        details: 'File metadata exists but content is not available'
      });
    }

    const content = await fs.promises.readFile(
      path.join(STORAGE_PATH, file.storage_path)
    );

    return res.json({
      ...file,
      content: content.toString('base64')
    });

  } catch (error) {
    console.error('Get file error:', error);
    return res.status(500).json({
      error: 'Failed to retrieve file',
      details: process.env.NODE_ENV === 'development' ? {
        message: error.message,
        stack: error.stack,
        fullError: error
      } : undefined
    });
  }
};

const getFile = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.user_id;

    const file = await pool.query(
      `SELECT id, name, type, size, parent_id, created_at, updated_at, encrypted 
       FROM files 
       WHERE id = $1 AND owner_id = $2`,
      [id, userId]
    ).then(r => r.rows[0]);

    if (!file) return res.status(404).json({ error: 'File not found' });
    return res.json(file);
  } catch (error) {
    console.error('Get file error:', error);
    return res.status(500).json({ error: 'Failed to get file' });
  }
};

const downloadFile = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.user_id;

    const hasAccess = await pool.query(
      'SELECT 1 FROM files WHERE id = $1 AND owner_id = $2',
      [id, userId]
    ).then(r => r.rows.length > 0);

    if (!hasAccess) return res.status(404).json({ error: 'File not found' });

    const filePath = path.join(__dirname, '../../uploads', userId.toString(), id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File content not found' });
    }

    const fileData = fs.readFileSync(filePath);
    return res.send(fileData);
  } catch (error) {
    console.error('Download error:', error);
    return res.status(500).json({ error: 'File download failed' });
  }
};

const updateFile = async (req, res) => {
  try {
    const { id } = req.params;
    const { encryptedData, fileName, parentId } = req.body;
    const userId = req.user.user_id;

    if (!id || !userId) {
      return res.status(400).json({ error: 'Missing file ID or user ID' });
    }

    // Fetch existing file info (e.g., path, size)
    const existing = await pool.query(
      'SELECT storage_path, size FROM files WHERE id = $1 AND owner_id = $2',
      [id, userId]
    ).then(r => r.rows[0]);

    if (!existing) {
      return res.status(404).json({ error: 'File not found or access denied' });
    }

    let size = existing.size;

    // If encryptedData is provided, overwrite file and update size
    if (encryptedData) {
      const buffer = Buffer.from(encryptedData, 'base64');

      const user = await pool.query(
        'SELECT used_storage, storage_limit FROM users WHERE id = $1',
        [userId]
      ).then(r => r.rows[0]);

      if (!user) return res.status(404).json({ error: 'User not found' });

      const newUsage = user.used_storage - existing.size + buffer.length;
      const maxLimit = user.storage_limit || 1073741824;

      if (newUsage > maxLimit) {
        return res.status(403).json({ error: 'Not enough storage space' });
      }

      // Overwrite the file on disk
      const fs = require('fs');
      fs.writeFileSync(existing.storage_path, buffer);

      // Update user storage usage
      await pool.query(
        'UPDATE users SET used_storage = $1 WHERE id = $2',
        [newUsage, userId]
      );

      size = buffer.length;
    }

    // Update metadata
    const result = await pool.query(
      `UPDATE files SET
        name = COALESCE($1, name),
        parent_id = COALESCE($2, parent_id),
        size = $3,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND owner_id = $5
       RETURNING id, name, type, size, parent_id, created_at, updated_at, encrypted`,
      [fileName, parentId, size, id, userId]
    );

    const file = result.rows[0];
    return res.json(file);
  } catch (error) {
    console.error('Update error:', error);
    return res.status(500).json({ error: 'File update failed' });
  }
};

const deleteFile = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.user_id;

    // Fetch file info (for file path and size)
    const file = await pool.query(
      'SELECT storage_path, size FROM files WHERE id = $1 AND owner_id = $2',
      [id, userId]
    ).then(r => r.rows[0]);

    if (!file) {
      return res.status(404).json({ error: 'File not found or access denied' });
    }

    // Delete file from disk
    if (fs.existsSync(file.storage_path)) {
      fs.unlinkSync(file.storage_path);
    }

    // Remove DB record
    await pool.query('DELETE FROM files WHERE id = $1 AND owner_id = $2', [id, userId]);

    // Update used storage
    await pool.query(
      'UPDATE users SET used_storage = used_storage - $1 WHERE id = $2',
      [file.size, userId]
    );

    return res.json({ message: 'File permanently deleted' });
  } catch (error) {
    console.error('Delete error:', error);
    return res.status(500).json({ error: 'Failed to permanently delete file' });
  }
};

const copyFile = async (req, res) => {
  if (!req.params.id || !isValidUUID(req.params.id)) {
    return res.status(400).json({ error: 'Invalid file ID' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const userId = req.user.user_id;
    const newFileId = uuidv4();

    // 1. Get original file metadata
    const { rows: [originalFile] } = await client.query(
      `SELECT name, type, mime_type, size, parent_id, owner_id, 
       storage_path, encrypted, iv, encrypted_aes_key, path
       FROM files WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
      [id, userId]
    );

    if (!originalFile) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'File not found or access denied' });
    }

    // 2. Generate unique copy name with "Copy of" pattern
    const { rows: [{ count }] } = await client.query(
      `SELECT COUNT(*) FROM files 
       WHERE owner_id = $1 AND parent_id = $2 AND name LIKE $3`,
      [userId, originalFile.parent_id, `Copy of ${originalFile.name}%`]
    );

    const newName = count > 0 
      ? `Copy (${count}) of ${originalFile.name}`
      : `Copy of ${originalFile.name}`;

    // 3. Verify storage quota
    const { rows: [user] } = await client.query(
      `SELECT used_storage, storage_limit 
       FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );

    if (Number(user.used_storage) + Number(originalFile.size) > Number(user.storage_limit)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ 
        error: 'Storage quota exceeded',
        available: user.storage_limit - user.used_storage,
        required: originalFile.size
      });
    }

    // 4. Prepare storage paths
    const uploadDir = path.join(process.cwd(), 'user_uploads', userId);
    const newStoragePath = path.join(uploadDir, newFileId);

    try {
      await mkdirAsync(uploadDir, { recursive: true });
      await copyFileAsync(originalFile.storage_path, newStoragePath);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('File system error:', err);
      return res.status(500).json({ 
        error: 'Failed to create file copy',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }

    // 5. Create database record
    const { rows: [copiedFile] } = await client.query(
      `INSERT INTO files (
        id, name, type, mime_type, size, parent_id, owner_id,
        storage_path, encrypted, iv, encrypted_aes_key, path,
        is_starred, is_trashed, is_archived
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, false, false)
      RETURNING *`,
      [
        newFileId,
        newName,
        originalFile.type,
        originalFile.mime_type,
        originalFile.size,
        originalFile.parent_id,
        userId,
        newStoragePath,
        originalFile.encrypted,
        originalFile.iv,
        originalFile.encrypted_aes_key,
        originalFile.path
      ]
    );

    // 6. Update storage usage
    await client.query(
      'UPDATE users SET used_storage = used_storage + $1 WHERE id = $2',
      [originalFile.size, userId]
    );

    await client.query('COMMIT');
    return res.status(201).json(copiedFile);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Database error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message })
    });
  } finally {
    client.release();
  }
};

const getDrive = async (req, res) => {
  try {
    const { folderId } = req.query;
    const userId = req.user.user_id;

    const result = await pool.query(
      `(
        SELECT 
          f.id,
          f.name,
          f.type,
          NULL as mime_type,  -- drivefolders doesn't have mime_type
          NULL as size,       -- drivefolders doesn't have size
          f.parent_id,
          f.user_id as owner_id,
          NULL as storage_path,  -- drivefolders doesn't have storage_path
          f.created_at,
          f.updated_at,
          f.is_trashed,
          false as is_starred,   -- drivefolders doesn't have is_starred
          f.location,
          json_build_object(
            'id', u.id,
            'email', u.email,
            'username', u.username,
            'avatar', u.avatar,
            'storage_limit', u.storage_limit,
            'used_storage', u.used_storage
          ) as owner,
          true as is_folder
        FROM drivefolders f
        JOIN users u ON f.user_id = u.id
        WHERE f.user_id = $1 AND f.parent_id ${folderId ? '= $2' : 'IS NULL'} AND f.is_trashed = false
      )
      UNION ALL
      (
        SELECT 
          f.id,
          f.name,
          f.type,
          f.mime_type,
          f.size,
          f.parent_id,
          f.owner_id,
          f.storage_path,
          f.created_at,
          f.updated_at,
          f.is_trashed,
          f.is_starred,
          NULL as location,  -- files doesn't have location
          json_build_object(
            'id', u.id,
            'email', u.email,
            'username', u.username,
            'avatar', u.avatar,
            'storage_limit', u.storage_limit,
            'used_storage', u.used_storage
          ) as owner,
          (f.type = 'folder') as is_folder
        FROM files f
        JOIN users u ON f.owner_id = u.id
        WHERE f.owner_id = $1 AND f.parent_id ${folderId ? '= $2' : 'IS NULL'} AND f.is_trashed = false
      )
      ORDER BY is_folder DESC, name ASC`,
      folderId ? [userId, folderId] : [userId]
    );

    const driveItems = result.rows;
    const driveFolders = driveItems.filter(item => item.is_folder);
    const driveFiles = driveItems.filter(item => !item.is_folder);

    const response = {
      success: true,
      data: {
        driveItems,
        driveFolders,
        driveFiles,
        currentFolder: folderId || 'root',
        owner: driveItems[0]?.owner || null
      },
      counts: {
        total: driveItems.length,
        folders: driveFolders.length,
        files: driveFiles.length
      }
    };

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ 
      success: false,
      error: 'Server error',
      message: err.message
    });
  }
};

// Recent files
const getRecent = async (req, res) => {
  try {
    const { limit = 20, cursor, filter } = req.query;
    const userId = req.user.user_id;

    // Validate filter parameter
    const validFilters = ['today', 'week', 'month', 'year'];
    if (filter && !validFilters.includes(filter)) {
      return res.status(400).json({ error: 'Invalid filter parameter' });
    }

    // Calculate date ranges based on filter
    let dateFilter = '';
    let dateParams = [];
    const now = new Date();
    
    if (filter === 'today') {
      const startOfDay = new Date(now.setHours(0, 0, 0, 0));
      dateFilter = 'AND f.created_at >= $' + (cursor ? 4 : 3);
      dateParams = [startOfDay];
    } else if (filter === 'week') {
      const startOfWeek = new Date(now.setDate(now.getDate() - 7));
      dateFilter = 'AND f.created_at >= $' + (cursor ? 4 : 3);
      dateParams = [startOfWeek];
    } else if (filter === 'month') {
      const startOfMonth = new Date(now.setDate(now.getDate() - 30));
      dateFilter = 'AND f.created_at >= $' + (cursor ? 4 : 3);
      dateParams = [startOfMonth];
    } else if (filter === 'year') {
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      dateFilter = 'AND f.created_at >= $' + (cursor ? 4 : 3);
      dateParams = [startOfYear];
    }

    const query = `
      SELECT 
        f.id, 
        f.name, 
        f.type,
        f.mime_type,
        f.size, 
        f.parent_id,
        f.storage_path,
        f.encrypted,
        f.iv,
        f.encrypted_aes_key,
        f.created_at, 
        f.updated_at,
        f.is_starred,
        f.last_starred_at,
        f.is_trashed,
        f.trashed_at,
        f.is_archived,
        f.archived_at,
        f.importance_score,
        f.path,
        f.shared_status,
        json_build_object(
          'id', u.id,
          'email', u.email,
          'username', u.username,
          'avatar', u.avatar,
          'storage_limit', u.storage_limit,
          'used_storage', u.used_storage
        ) as owner
      FROM files f
      JOIN users u ON f.owner_id = u.id
      WHERE f.owner_id = $1 
        AND f.is_trashed = false
        ${cursor ? 'AND f.updated_at < $3' : ''}
        ${dateFilter}
      ORDER BY f.updated_at DESC
      LIMIT $2
    `;

    const baseParams = cursor ? [userId, limit, cursor] : [userId, limit];
    const params = [...baseParams, ...dateParams];

    const result = await pool.query(query, params);

    res.json({
      files: result.rows,
      nextCursor: result.rows.length > 0 ? 
        result.rows[result.rows.length - 1].updated_at : null,
      filter: filter || 'all',
      filterStartDate: dateParams[0] || null
    });
  } catch (err) {
    console.error('Get recent error:', err);
    res.status(500).json({ 
      error: 'Failed to get recent files',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// Starred files
const getStarred = async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const userId = req.user.user_id;

    const query = `
      SELECT 
        f.id, 
        f.name, 
        f.type,
        f.mime_type,
        f.size, 
        f.parent_id,
        f.storage_path,
        f.encrypted,
        f.iv,
        f.encrypted_aes_key,
        f.created_at, 
        f.updated_at,
        f.is_starred,
        f.last_starred_at,
        f.is_trashed,
        f.trashed_at,
        f.is_archived,
        f.archived_at,
        f.importance_score,
        f.path,
        f.shared_status,
        json_build_object(
          'id', u.id,
          'email', u.email,
          'username', u.username,
          'avatar', u.avatar,
          'storage_limit', u.storage_limit,
          'used_storage', u.used_storage
        ) as owner
      FROM files f
      JOIN users u ON f.owner_id = u.id
      WHERE f.owner_id = $1 AND f.is_starred = true AND f.is_trashed = false
      ORDER BY f.last_starred_at DESC
      LIMIT $2
    `;

    const result = await pool.query(query, [userId, limit]);
    res.json(result.rows);
  } catch (err) {
    console.error('Get starred error:', err);
    res.status(500).json({ 
      error: 'Failed to get starred files',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// Trash
const getTrash = async (req, res) => {
  try {
    const userId = req.user.user_id;

    const query = `
      SELECT 
        f.id, 
        f.name, 
        f.type,
        f.mime_type,
        f.size, 
        f.parent_id,
        f.storage_path,
        f.encrypted,
        f.iv,
        f.encrypted_aes_key,
        f.created_at, 
        f.updated_at,
        f.is_starred,
        f.last_starred_at,
        f.is_trashed,
        f.trashed_at,
        f.is_archived,
        f.archived_at,
        f.importance_score,
        f.path,
        f.shared_status,
        json_build_object(
          'id', u.id,
          'email', u.email,
          'username', u.username,
          'avatar', u.avatar,
          'storage_limit', u.storage_limit,
          'used_storage', u.used_storage
        ) as owner
      FROM files f
      JOIN users u ON f.owner_id = u.id
      WHERE f.owner_id = $1 AND f.is_trashed = true
      ORDER BY f.trashed_at DESC
    `;

    const result = await pool.query(query, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Get trash error:', err);
    res.status(500).json({ 
      error: 'Failed to get trash',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// Update file state
const updateFileState = async (req, res) => {
  try {
    const { id, field, value } = req.params;
    const userId = req.user.user_id; // From auth middleware
console.log("parrams",req.params)
console.log("userid",userId)
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

    // Field to timestamp mapping
    const timestampMap = {
      'is_starred': 'last_starred_at',
      'is_trashed': 'trashed_at',
      'is_archived': 'archived_at'
    };

    const query = `
      UPDATE files 
      SET ${field} = $1,
          ${timestampMap[field]} = ${boolValue ? 'NOW()' : 'NULL'}
      WHERE id = $2 AND owner_id = $3
      RETURNING *
    `;

    const result = await pool.query(query, [boolValue, id, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: 'File not found or not owned by user'
      });
    }

    res.json({
      success: true,
      file: result.rows[0]
    });

  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ 
      error: 'Server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
}

// Rename file state - Improved version
const renameFile = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.user_id;
  const newName = (req.body.name || '').trim();

  // Debug logging
  console.log(`Rename request - File: ${id}, User: ${userId}, New name: ${newName}`);

  // Validation
  if (!newName) {
    return res.status(400).json({
      error: "Invalid request",
      message: "File name is required"
    });
  }

  if (!/^[a-zA-Z0-9_.\-\s]+$/.test(newName)) {
    return res.status(400).json({
      error: "Invalid file name",
      message: "File name can only contain letters, numbers, spaces, underscores, hyphens, and dots",
      code: "INVALID_FILE_NAME"
    });
  }

  const client = await pool.connect();

  try {
    // Debug: Check file existence without owner restriction
    const fileExists = await client.query(
      `SELECT id, owner_id FROM files WHERE id = $1`,
      [id]
    );
    
    if (fileExists.rowCount === 0) {
      console.log(`File ${id} does not exist at all`);
      return res.status(404).json({
        error: "File not found",
        message: "The requested file does not exist",
        code: "FILE_NOT_FOUND"
      });
    }

    // Check owner mismatch
    if (fileExists.rows[0].owner_id !== userId) {
      console.log(`Owner mismatch - File owner: ${fileExists.rows[0].owner_id}, Requesting user: ${userId}`);
      return res.status(403).json({
        error: "Permission denied",
        message: "You don't have permission to access this file",
        code: "PERMISSION_DENIED"
      });
    }

    // Check for duplicate name in same parent directory
    const existingFile = await client.query(
      `SELECT id FROM files 
       WHERE name = $1 
       AND owner_id = $2 
       AND parent_id = (SELECT parent_id FROM files WHERE id = $3)
       AND id != $3`,
      [newName, userId, id]
    );

    if (existingFile.rowCount > 0) {
      return res.status(409).json({
        error: "File exists",
        message: "A file with this name already exists in this location",
        code: "FILE_EXISTS"
      });
    }

    // Perform the update
    const updatedFile = await client.query(
      `UPDATE files
       SET name = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, name, type, mime_type, size, updated_at`,
      [newName, id]
    );

    return res.json({
      data: updatedFile.rows[0],
      message: "File renamed successfully"
    });

  } catch (err) {
    console.error("Database error:", err);
    return res.status(500).json({
      error: "Server error",
      message: "An error occurred while renaming the file",
      code: "SERVER_ERROR"
    });
  } finally {
    client.release();
  }
};


// const getDriveData = async (req, res) => {
//   try {
//     const { type = 'drive', folderId, limit = 100, page = 1, cursor, filter } = req.query;
//     const userId = req.user.user_id;
//     const offset = (page - 1) * limit;

//     // Validate parameters
//     const validTypes = ['drive', 'recent', 'starred', 'trash'];
//     if (!validTypes.includes(type)) {
//       return res.status(400).json({
//         success: false,
//         error: 'Invalid type parameter',
//         message: `Type must be one of: ${validTypes.join(', ')}`
//       });
//     }

//     // Date filter for recent items
//     let dateFilter = '';
//     let dateParams = [];
//     if (type === 'recent' && filter) {
//       const now = new Date();
//       switch (filter) {
//         case 'today':
//           dateFilter = 'AND f.updated_at >= $' + (cursor ? 5 : 4);
//           dateParams = [new Date(now.setHours(0, 0, 0, 0))];
//           break;
//         case 'week':
//           dateFilter = 'AND f.updated_at >= $' + (cursor ? 5 : 4);
//           dateParams = [new Date(now.setDate(now.getDate() - 7))];
//           break;
//         case 'month':
//           dateFilter = 'AND f.updated_at >= $' + (cursor ? 5 : 4);
//           dateParams = [new Date(now.setMonth(now.getMonth() - 1))];
//           break;
//         case 'year':
//           dateFilter = 'AND f.updated_at >= $' + (cursor ? 5 : 4);
//           dateParams = [new Date(now.getFullYear(), 0, 1)];
//           break;
//       }
//     }

//     // Base query parameters
//     let baseParams = [userId];
//     if (folderId) baseParams.push(folderId);
//     if (cursor) baseParams.push(cursor);
//     if (dateParams.length) baseParams = [...baseParams, ...dateParams];
    
//     // Main query construction
//     let query, countQuery;
//     switch (type) {
//       case 'drive':
//         query = `
//           WITH combined_items AS (
//             (
//               SELECT 
//                 f.id,
//                 f.name,
//                 f.type,
//                 NULL as mime_type,
//                 NULL as size,
//                 f.parent_id,
//                 f.user_id as owner_id,
//                 NULL as storage_path,
//                 f.created_at,
//                 f.updated_at,
//                 f.is_trashed,
//                 false as is_starred,
//                 f.location,
//                 json_build_object(
//                   'id', u.id,
//                   'email', u.email,
//                   'username', u.username,
//                   'avatar', u.avatar,
//                   'storage_limit', u.storage_limit,
//                   'used_storage', u.used_storage
//                 ) as owner,
//                 true as is_folder
//               FROM drivefolders f
//               JOIN users u ON f.user_id = u.id
//               WHERE f.user_id = $1 AND f.parent_id ${folderId ? '= $2' : 'IS NULL'} AND f.is_trashed = false
//             )
//             UNION ALL
//             (
//               SELECT 
//                 f.id,
//                 f.name,
//                 f.type,
//                 f.mime_type,
//                 f.size,
//                 f.parent_id,
//                 f.owner_id,
//                 f.storage_path,
//                 f.created_at,
//                 f.updated_at,
//                 f.is_trashed,
//                 f.is_starred,
//                 NULL as location,
//                 json_build_object(
//                   'id', u.id,
//                   'email', u.email,
//                   'username', u.username,
//                   'avatar', u.avatar,
//                   'storage_limit', u.storage_limit,
//                   'used_storage', u.used_storage
//                 ) as owner,
//                 (f.type = 'folder') as is_folder
//               FROM files f
//               JOIN users u ON f.owner_id = u.id
//               WHERE f.owner_id = $1 AND f.parent_id ${folderId ? '= $2' : 'IS NULL'} AND f.is_trashed = false
//             )
//           )
//           SELECT * FROM combined_items
//           ORDER BY is_folder DESC, name ASC
//           LIMIT $${folderId ? 3 : 2} OFFSET $${folderId ? 4 : 3}
//         `;

//         // Improved count query that matches the UNION ALL logic
//         countQuery = `
//           SELECT COUNT(*) as total_count FROM (
//             SELECT 1 FROM drivefolders f
//             WHERE f.user_id = $1 AND f.parent_id ${folderId ? '= $2' : 'IS NULL'} AND f.is_trashed = false
//             UNION ALL
//             SELECT 1 FROM files f
//             WHERE f.owner_id = $1 AND f.parent_id ${folderId ? '= $2' : 'IS NULL'} AND f.is_trashed = false
//           ) as combined
//         `;
//         break;

//       case 'recent':
//         query = `
//           SELECT 
//             f.id, 
//             f.name, 
//             f.type,
//             f.mime_type,
//             f.size,
//             f.storage_path,
//             f.created_at,
//             f.updated_at,
//             f.is_starred,
//             f.last_starred_at,
//             f.is_trashed,
//             f.trashed_at,
//             f.is_archived,
//             f.archived_at,
//             f.importance_score,
//             f.path,
//             f.shared_status,
//             json_build_object(
//               'id', u.id,
//               'email', u.email,
//               'username', u.username,
//               'avatar', u.avatar
//             ) as owner,
//             false as is_folder
//           FROM files f
//           JOIN users u ON f.owner_id = u.id
//           WHERE f.owner_id = $1 
//             AND f.is_trashed = false
//             ${cursor ? 'AND f.updated_at < $3' : ''}
//             ${dateFilter}
//           ORDER BY f.updated_at DESC
//           LIMIT $${cursor ? 4 : 2} OFFSET $${cursor ? 5 : 3}
//         `;

//         countQuery = `
//           SELECT COUNT(*) FROM files f
//           WHERE f.owner_id = $1 AND f.is_trashed = false
//           ${dateFilter}
//         `;
//         break;

//       case 'starred':
//         query = `
//           SELECT 
//             f.id, 
//             f.name, 
//             f.type,
//             f.mime_type,
//             f.size,
//             f.storage_path,
//             f.created_at,
//             f.updated_at,
//             f.is_starred,
//             f.last_starred_at,
//             json_build_object(
//               'id', u.id,
//               'email', u.email,
//               'username', u.username,
//               'avatar', u.avatar
//             ) as owner,
//             false as is_folder
//           FROM files f
//           JOIN users u ON f.owner_id = u.id
//           WHERE f.owner_id = $1 AND f.is_starred = true AND f.is_trashed = false
//           ORDER BY f.last_starred_at DESC
//           LIMIT $2 OFFSET $3
//         `;

//         countQuery = `
//           SELECT COUNT(*) FROM files 
//           WHERE owner_id = $1 AND is_starred = true AND is_trashed = false
//         `;
//         break;

//       case 'trash':
//         query = `
//           SELECT 
//             f.id, 
//             f.name, 
//             f.type,
//             f.mime_type,
//             f.size,
//             f.storage_path,
//             f.created_at,
//             f.trashed_at,
//             json_build_object(
//               'id', u.id,
//               'email', u.email,
//               'username', u.username,
//               'avatar', u.avatar
//             ) as owner,
//             false as is_folder
//           FROM files f
//           JOIN users u ON f.owner_id = u.id
//           WHERE f.owner_id = $1 AND f.is_trashed = true
//           ORDER BY f.trashed_at DESC
//           LIMIT $2 OFFSET $3
//         `;

//         countQuery = `
//           SELECT COUNT(*) FROM files 
//           WHERE owner_id = $1 AND is_trashed = true
//         `;
//         break;
//     }

//     // Execute queries
//     const result = await pool.query(query, [...baseParams, limit, offset]);
    
//     // For drive type, we need to ensure we're counting the exact same items as in the main query
//     let totalItems;
//     if (type === 'drive') {
//       // Execute the count query with the same parameters as the main query
//       const countResult = await pool.query(countQuery, baseParams.slice(0, folderId ? 2 : 1));
//       totalItems = parseInt(countResult.rows[0]?.total_count || 0);
//     } else {
//       // For other types, use the simpler count query
//       const countResult = await pool.query(countQuery, baseParams.slice(0, folderId ? 2 : 1));
//       totalItems = parseInt(countResult.rows[0]?.count || 0);
//     }

//     // Calculate total pages
//     const totalPages = Math.ceil(totalItems / limit);

//     // Format consistent response
//     const response = {
//       success: true,
//       data: {
//         items: result.rows,
//         // folders: type === 'drive' ? result.rows.filter(item => item.is_folder) : [],
//         // files: type === 'drive' ? result.rows.filter(item => !item.is_folder) : result.rows,
//         currentFolder: type === 'drive' ? folderId || 'root' : null,
//         type,
//         pagination: {
//           total: totalItems,
//           page: parseInt(page),
//           limit: parseInt(limit),
//           totalPages: totalPages
//         },
//         ...(type === 'recent' && result.rows.length > 0 && { nextCursor: result.rows[result.rows.length - 1].updated_at }),
//         ...(type === 'recent' && filter && { filter })
//       }
//     };

//     // Debug logging to verify counts
//     console.log(`Returning ${result.rows.length} items with total count ${totalItems}`);

//     res.json(response);
//   } catch (err) {
//     console.error('Drive data error:', err);
//     res.status(500).json({ 
//       success: false,
//       error: 'Server error',
//       message: err.message,
//       stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
//     });
//   }
// };


const getDriveData = async (req, res) => {
  try {
    const { type = 'drive', folderId, limit = 100, page = 1, cursor, filter } = req.query;
    const userId = req.user.user_id;
    const offset = (page - 1) * limit;

    const validTypes = ['drive', 'recent', 'starred', 'trash'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid type parameter',
        message: `Type must be one of: ${validTypes.join(', ')}`
      });
    }

    let dateFilter = '';
    let dateParam;
    const baseParams = [userId];

    if (folderId) baseParams.push(folderId);

    if (filter) {
      const now = new Date();
      switch (filter) {
        case 'today':
          dateParam = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
          break;
        case 'week':
          dateParam = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7)).toISOString();
          break;
        case 'month':
          dateParam = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, now.getUTCDate())).toISOString();
          break;
        case 'year':
          dateParam = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
          break;
      }
      if (dateParam) {
        baseParams.push(dateParam);
        dateFilter = `AND f.created_at >= $${baseParams.length}`;
      }
    }

    const commonFolderSelect = `
      f.id, f.name, f.type, NULL as mime_type, NULL as size, f.parent_id, f.user_id as owner_id, NULL as storage_path,
      f.created_at, f.updated_at, f.is_trashed, f.is_starred, f.location,
      json_build_object('id', u.id, 'email', u.email, 'username', u.username, 'avatar', u.avatar, 'storage_limit', u.storage_limit, 'used_storage', u.used_storage) as owner,
      true as is_folder
    `;

    const commonFileSelect = `
      f.id, f.name, f.type, f.mime_type, f.size, f.parent_id, f.owner_id, f.storage_path,
      f.created_at, f.updated_at, f.is_trashed, f.is_starred, NULL as location,
      json_build_object('id', u.id, 'email', u.email, 'username', u.username, 'avatar', u.avatar, 'storage_limit', u.storage_limit, 'used_storage', u.used_storage) as owner,
      false as is_folder
    `;

    const folderCondition = folderId ? '= $2' : 'IS NULL';

    const orderField = type === 'recent' ? 'created_at' : 'created_at'; // kept generic and consistent

    const buildQuery = () => `
      WITH combined_items AS (
        (
          SELECT ${commonFolderSelect}
          FROM drivefolders f JOIN users u ON f.user_id = u.id
          WHERE f.user_id = $1 AND f.parent_id ${folderCondition} 
          ${type === 'trash' ? 'AND f.is_trashed = true' : 'AND f.is_trashed = false'}
          ${type === 'starred' ? 'AND f.is_starred = true' : ''}
          ${dateFilter}
          ${cursor ? `AND f.created_at < $${baseParams.length + 1}` : ''}
        )
        UNION ALL
        (
          SELECT ${commonFileSelect}
          FROM files f JOIN users u ON f.owner_id = u.id
          WHERE f.owner_id = $1 AND f.parent_id ${folderCondition} 
          ${type === 'trash' ? 'AND f.is_trashed = true' : 'AND f.is_trashed = false'}
          ${type === 'starred' ? 'AND f.is_starred = true' : ''}
          ${dateFilter}
          ${cursor ? `AND f.created_at < $${baseParams.length + 1}` : ''}
        )
      )
      SELECT * FROM combined_items
      ORDER BY ${orderField} DESC
      LIMIT $${baseParams.length + (cursor ? 2 : 1)} OFFSET $${baseParams.length + (cursor ? 3 : 2)}
    `;

    const buildCountQuery = () => `
      SELECT COUNT(*) as total_count FROM (
        SELECT 1 FROM drivefolders f 
        WHERE f.user_id = $1 AND f.parent_id ${folderCondition} 
        ${type === 'trash' ? 'AND f.is_trashed = true' : 'AND f.is_trashed = false'}
        ${type === 'starred' ? 'AND f.is_starred = true' : ''}
        ${dateFilter}
        ${cursor ? `AND f.created_at < $${baseParams.length + 1}` : ''}
        UNION ALL
        SELECT 1 FROM files f 
        WHERE f.owner_id = $1 AND f.parent_id ${folderCondition} 
        ${type === 'trash' ? 'AND f.is_trashed = true' : 'AND f.is_trashed = false'}
        ${type === 'starred' ? 'AND f.is_starred = true' : ''}
        ${dateFilter}
        ${cursor ? `AND f.created_at < $${baseParams.length + 1}` : ''}
      ) as combined
    `;

    const queryParams = [...baseParams];
    if (cursor) queryParams.push(cursor);
    queryParams.push(limit, offset);

    const countParams = [...baseParams];
    if (cursor) countParams.push(cursor);

    const result = await pool.query(buildQuery(), queryParams);
    const countResult = await pool.query(buildCountQuery(), countParams);

    const totalItems = parseInt(countResult.rows[0]?.total_count || 0);
    const totalPages = Math.ceil(totalItems / limit);

    res.json({
      success: true,
      data: {
        items: result.rows,
        currentFolder: type === 'drive' ? folderId || 'root' : null,
        type,
        pagination: {
          total: totalItems,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages
        },
        ...(type === 'recent' && result.rows.length > 0 && { nextCursor: result.rows[result.rows.length - 1].created_at }),
        ...(filter && { filter })
      }
    });
  
  } catch (err) {
    console.error('Drive data error:', err);
    res.status(500).json({ 
      success: false,
      error: 'Server error',
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
};



const permanentDeleteFile = async (req, res) => {
  const client = await pool.connect();
  try {
    const { fileId } = req.params;
    const userId = req.user.user_id;

    // Validate file ID
    if (!isValidUUID(fileId)) {
      return res.status(400).json({ 
        error: 'Invalid file ID format',
        code: 'INVALID_FILE_ID'
      });
    }

    await client.query('BEGIN');

    // Get file record with additional metadata
    const { rows: [file] } = await client.query(
      `SELECT f.id, f.storage_path, f.size, f.name, f.mime_type
       FROM files f
       WHERE f.id = $1 AND f.owner_id = $2
       FOR UPDATE`,
      [fileId, userId]
    );

    if (!file) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        error: 'File not found or no permission',
        code: 'FILE_NOT_FOUND'
      });
    }

    // Enhanced file deletion with retries and fallback
    const deletionResult = await attemptFileDeletion(file.storage_path);
    
    if (!deletionResult.success) {
      await handleFailedDeletion(client, file);
      return res.status(500).json({
        error: 'Failed to delete physical file',
        code: 'PHYSICAL_DELETE_FAILED',
        details: {
          fileName: file.name,
          status: 'marked_for_cleanup',
          adminReference: `FILE_${file.id}`
        }
      });
    }

    // Proceed with database operations
    await client.query('DELETE FROM files WHERE id = $1', [fileId]);
    await client.query(
      'UPDATE users SET used_storage = used_storage - $1 WHERE id = $2',
      [file.size, userId]
    );

    await client.query('COMMIT');
    
    return res.status(200).json({ 
      success: true,
      message: 'File permanently deleted',
      data: {
        freedSpace: file.size,
        fileName: file.name
      }
    });

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Permanent delete transaction error:', error);
    return res.status(500).json({ 
      error: 'File deletion process failed',
      code: 'DELETION_PROCESS_FAILED',
      systemError: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
};

// Helper functions
async function attemptFileDeletion(storagePath, maxRetries = 3) {
  const fullPath = path.join(process.env.STORAGE_ROOT, storagePath);
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      await fs.promises.unlink(fullPath);
      return { success: true };
    } catch (err) {
      retryCount++;
      if (retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 500 * retryCount));
      } else {
        return { 
          success: false,
          error: err,
          attempts: retryCount
        };
      }
    }
  }
}

async function handleFailedDeletion(client, file) {
  // Mark file for later cleanup
  await client.query(`
    INSERT INTO failed_deletions 
    (file_id, original_path, last_attempt, attempts)
    VALUES ($1, $2, NOW(), 1)
    ON CONFLICT (file_id) 
    DO UPDATE SET attempts = failed_deletions.attempts + 1
  `, [file.id, file.storage_path]);
  
  await client.query('ROLLBACK');
}
module.exports = {
  uploadFile,
  getFiles,
  getFile,
  getFileContent,
  downloadFile,
  updateFile,
  deleteFile,
  copyFile,
  getDrive,
  getRecent,
  getStarred,
  getTrash,
  updateFileState,
  renameFile,
  getDriveData,
  permanentDeleteFile

};