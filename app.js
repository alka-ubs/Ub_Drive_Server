const express = require("express");
const cors = require("cors");
const userRouter = require("./routers/user.router");
const fileRouter = require("./routers/file.router");
const folderRouter = require("./routers/folder.router");
const shareRouter = require("./routers/share.router");
const keyRouter = require("./routers/driveKey");
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const jwt = require("jsonwebtoken");
const http = require('http');
const socketIo = require("socket.io");
const startImapWatcher = require("./watcher/imapWatcher");
const pool = require("./db");
const authenticateAdminOnly = require("./middleware/authenticateAdminOnly");
const authenticate = require("./middleware/auth.middleware");
const sharedSession = require("express-socket.io-session");
const { google } = require('googleapis');



require("dotenv").config();
require("./db")
const app = express();
const server = http.createServer(app);
const sessionMiddileware = session({
  store: new pgSession({
    pool,
    tableName: 'session', // More descriptive name
    createTableIfMissing: false,
    pruneSessionInterval: 60 // Clean up expired sessions every 60 minutes
  }),
  secret: process.env.SESSION_SECRET,
  name: 'ubshq.sid', // Custom session cookie name
  resave: false,
  saveUninitialized: false,
  rolling: true, // Renew cookie on activity
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    secure: true, // Required for HTTPS
    sameSite: 'none', // Required for cross-site
    domain: process.env.NODE_ENV === 'production' ? '.ubshq.com' : undefined // Allow subdomains
  }
});

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

app.use(cors({
  origin: [
    'https://mail.ubshq.com',
    'https://localhost:5173',
    'http://localhost:5173',
    'https://dev-mail.ubshq.com',
    "http://localhost:4000"
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-CSRF-Token',
    'x-file-category' 
  ],
  credentials: true,
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(sessionMiddileware);


app.get('/google/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent',
    state: req.query.sessionId || 'default' // Optional session identifier
  });
  res.redirect(url);
});

// 2. OAuth Callback Handler
// 2. OAuth Callback Handler
app.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.send(`<script>
      window.opener.postMessage({ error: "${error}" }, "*");
      window.close();
    </script>`);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Send token to opener and close the popup
    res.send(`<script>
      window.opener.postMessage({
        access_token: "${tokens.access_token}"
      }, "*");
      window.close();
    </script>`);
  } catch (err) {
    res.send(`<script>
      window.opener.postMessage({ error: "Token exchange failed" }, "*");
      window.close();
    </script>`);
  }
});
;

// 3. Import Endpoint (uses temporary access token)
app.post('/import/gmail', async (req, res) => {
  try {
    const { access_token } = req.body;
    
    if (!access_token) {
      return res.status(400).json({ error: 'No access token provided' });
    }

    // Set the provided access token
    oauth2Client.setCredentials({ access_token });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Get messages list
    const { data: { messages } } = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 20
    });

    // Process messages
    const imported = [];
    for (const message of messages || []) {
      try {
        const { data } = await gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'full'
        });

        // Extract headers
        const headers = {};
        data.payload.headers.forEach(header => {
          headers[header.name.toLowerCase()] = header.value;
        });

        // Function to process email parts
        const processPart = (part) => {
          const result = {};
          if (part.mimeType === 'text/plain' && part.body.data) {
            result.text = Buffer.from(part.body.data, 'base64').toString('utf-8');
          } else if (part.mimeType === 'text/html' && part.body.data) {
            result.html = Buffer.from(part.body.data, 'base64').toString('utf-8');
          } else if (part.parts) {
            // Handle multipart emails
            part.parts.forEach(p => {
              const processed = processPart(p);
              if (processed.text) result.text = processed.text;
              if (processed.html) result.html = processed.html;
            });
          }
          return result;
        };

        // Get body content
        const body = processPart(data.payload);
        
        // Get attachments if any
        const attachments = [];
        const processAttachments = (part) => {
          if (part.filename && part.body.attachmentId) {
            attachments.push({
              filename: part.filename,
              mimeType: part.mimeType,
              size: part.body.size,
              attachmentId: part.body.attachmentId
            });
          }
          if (part.parts) {
            part.parts.forEach(processAttachments);
          }
        };
        processAttachments(data.payload);

        // Construct complete message
        const completeMessage = {
          id: message.id,
          threadId: data.threadId,
          labelIds: data.labelIds,
          snippet: data.snippet,
          sizeEstimate: data.sizeEstimate,
          internalDate: new Date(parseInt(data.internalDate)).toISOString(),
          headers: headers,
          from: headers['from'],
          to: headers['to'],
          cc: headers['cc'],
          bcc: headers['bcc'],
          subject: headers['subject'],
          date: headers['date'],
          ...body, // This includes both text and html if available
          attachments: attachments
        };

        imported.push(completeMessage);
      } catch (err) {
        console.error(`Failed to process message ${message.id}:`, err);
      }
    }

    res.json({
      success: true,
      messages: imported
    });

  } catch (err) {
    console.error('Import failed:', err);
    
    if (err.response?.status === 401) {
      return res.status(401).json({ 
        error: 'Token expired or invalid',
        action: 'reauthenticate' 
      });
    }
    
    res.status(500).json({ 
      error: 'Import failed',
      details: err.message 
    });
  }
});

app.get('/debug/cookie', (req, res) => {
  console.log('🍪 Cookie header received:', req.headers.cookie);
  console.log('📦 SessionID in debug:', req.sessionID);
  console.log('📦 Session:', req.session);
  res.send('ok');
});

app.use("/users", userRouter);
app.use("/files",fileRouter);
app.use("/folder",folderRouter);
app.use("/shareWith",shareRouter);
app.use("/key",keyRouter)


// Session activity tracker
app.use(async (req, res, next) => {
  try {
    if (req.session?.sessionId) {
      await pool.query(`
        UPDATE user_sessions
        SET last_used_at = NOW()
        WHERE session_id = $1 AND is_active = true
      `, [req.session.sessionId]);
    }
  } catch (err) {
    console.error("Session tracking error:", err);
  }
  next();
});

// Error handler for session issues
app.use((err, req, res, next) => {
  if (err.code === '42P01') { // Table doesn't exist
    console.error('Database table missing:', err.table);
    return res.status(500).json({
      error: "System configuration error",
      code: "CONFIGURATION_ERROR"
    });
  }
  next(err);
});


app.post('/api/emails/:id/snooze', authenticate, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.user_id;
  const { snoozeUntil } = req.body;
  
  if (!userId || !snoozeUntil) {
      return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
      const result = await pool.query(
          'SELECT * FROM snooze_email($1, $2, $3)',
          [id, userId, snoozeUntil]
      );
      
      res.json(result.rows[0]);
  } catch (err) {
      console.error('Error snoozing email:', err);
      res.status(500).json({ error: 'Failed to snooze email' });
  }
});

console.log('🔌 Initializing Socket.IO server with CORS settings:', {
  origins: ["https://mail.ubshq.com", "https://localhost:5173", "http://localhost:5173", "http://localhost:3000","https://dev-mail.ubshq.com","http://localhost:4000"],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
});


//api.ubshq.com
const io = socketIo(server, {
  cors: {
    origin: ["https://mail.ubshq.com", "https://dev-mail.ubshq.com", "https://localhost:5173", "http://localhost:5173", "http://localhost:3000","https://dev-mail.ubshq.com","http://localhost:4000"],
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
  }
});

console.log('🔗 Attaching session middleware to Socket.IO');
io.use(sharedSession(sessionMiddileware, {
  autoSave: true,
  saveUninitialized: false
}));

// Debug Socket.IO engine events
io.engine.on("connection", (socket) => {
  console.log('⚡ Socket.IO engine connection established:', socket.id);
});

io.engine.on("connection_error", (err) => {
  console.error('💥 Socket.IO engine connection error:', {
    code: err.code,
    message: err.message,
    context: err.context
  });
});

// Enhanced Socket.IO middleware with logging
io.use(async (socket, next) => {
  // Skip authentication for disconnection events
  if (socket.handshake._query?.disconnect === 'true') {
    return next();
  }

  // Enhanced logging
  const authLogger = {
    start: Date.now(),
    socketId: socket.id,
    ip: socket.handshake.headers['x-forwarded-for'] || socket.handshake.address,
    userAgent: socket.handshake.headers['user-agent']
  };

  try {
    // Production: Session-based authentication
    if (process.env.NODE_ENV === 'production') {
      authLogger.mode = 'session';
      const session = socket.handshake.session;

      if (!session?.userId) {
        authLogger.error = 'No session found';
        throw new Error('Unauthorized: No valid session');
      }

      // Verify session consistency
      if (!session.csrfToken || !session.email) {
        authLogger.error = 'Invalid session data';
        await session.destroy();
        throw new Error('Unauthorized: Invalid session data');
      }

      // Verify user still exists
      const userResult = await pool.query(
        'SELECT id, email FROM users WHERE id = $1 AND email = $2 LIMIT 1',
        [session.userId, session.email]
      );

      if (userResult.rows.length === 0) {
        authLogger.error = 'User not found in DB';
        await session.destroy();
        throw new Error('Unauthorized: User not found');
      }

      // Attach user to socket
      socket.user = {
        user_id: session.userId,
        email: session.email,
        sessionId: session.id,
        csrfToken: session.csrfToken,
        ip: authLogger.ip
      };

      authLogger.userId = session.userId;
      authLogger.sessionId = session.id;
    } 
    // Development: JWT fallback
    else {
      authLogger.mode = 'jwt';
      const token = socket.handshake.auth.token || 
                   socket.handshake.headers.authorization?.split(' ')[1];

      if (!token) {
        authLogger.error = 'Missing token';
        throw new Error('Unauthorized: Missing token');
      }

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        console.log(decoded, "JWT DECODED");
        // Verify JWT contains required claims
        if (!decoded.user_id || !decoded.email) {
          authLogger.error = 'Invalid token claims';
          throw new Error('Unauthorized: Invalid token claims');
        }

        socket.user = {
          user_id: decoded.userId,
          email: decoded.email,
          sessionId: decoded.sessionId || 'jwt-mode',
          csrfToken: decoded.csrfToken || 'jwt-mode',
          ip: authLogger.ip
        };

        authLogger.userId = decoded.userId;
      } catch (jwtError) {
        authLogger.error = 'JWT verification failed';
        authLogger.jwtError = jwtError.message;
        throw new Error('Unauthorized: Invalid token');
      }
    }

    // Log successful authentication
    authLogger.duration = Date.now() - authLogger.start;
    console.log('🔐 Socket authenticated', authLogger);

    // Record connection in database
    try {
      await pool.query(
        `INSERT INTO socket_connections 
        (user_id, socket_id, ip_address, user_agent) 
        VALUES ($1, $2, $3, $4)`,
        [socket.user.user_id, socket.id, authLogger.ip, authLogger.userAgent]
      );
    } catch (dbError) {
      console.error('Failed to log socket connection:', dbError);
    }

    next();
  } catch (error) {
    // Enhanced error handling
    authLogger.duration = Date.now() - authLogger.start;
    authLogger.error = error.message;
    console.error('🔒 Socket auth failed', authLogger);

    // Custom disconnect message
    const err = new Error(error.message);
    err.data = {
      code: 'AUTH_FAILED',
      timestamp: new Date().toISOString(),
      sessionId: socket.handshake.session?.id
    };
    next(err);
  }
});

// Single connection handler with comprehensive logging
io.on('connection', async (socket) => {
  console.log('✅ Client connected:', {
    id: socket.id,
    user: socket.user,
    handshake: {
      headers: socket.handshake.headers,
      query: socket.handshake.query,
      auth: socket.handshake.auth
    }
  });

  // Debug all socket events
  socket.onAny((event, ...args) => {
    console.log(`📡 [${socket.id}] Event: ${event}`, args.length > 0 ? args : '');
  });

  if (!socket.user?.email) {
    console.error('❌ No user email found in socket:', {
      id: socket.id,
      user: socket.user
    });
    return socket.disconnect(true);
  }

  try {
      const imapCredentials = socket.handshake.auth?.imapCredentials;
      console.log('🔍 IMAP credentials from handshake:', imapCredentials)   ;
        
        if (!imapCredentials || !imapCredentials.email || !imapCredentials.password) {
            console.error('❌ No IMAP credentials provided');
            return socket.disconnect(true);
        }

        // Verify the email matches the authenticated user
        if (imapCredentials.email !== socket.user.email) {
            console.error('❌ Email mismatch between JWT and IMAP credentials');
            return socket.disconnect(true);
        }
    console.log('🔍 Fetching user from database:', socket.user.email);
    const { rows } = await pool.query(
      "SELECT password FROM users WHERE email = $1", 
      [socket.user.email]
    );
    
    if (rows.length === 0) {
      console.error('❌ User not found in database:', socket.user.email);
      return socket.disconnect(true);
    }

    const userPassword = rows[0].password;
    console.log('🔑 User password retrieved successfully');
    
    console.log(`🚪 Joining room for email: ${socket.user.email}`);
    socket.join(socket.user.email);
    
    console.log('👀 Starting IMAP watcher for:', socket.user.email);
    startImapWatcher(imapCredentials.email, imapCredentials.password, socket);
    
    socket.on('disconnect', (reason) => {
      console.log('❌ Client disconnected:', {
        id: socket.id,
        reason,
        user: socket.user?.email
      });
    });

    socket.on('error', (err) => {
      console.error('💥 Socket error:', {
        id: socket.id,
        error: err.message
      });
    });

  } catch (err) {
    console.error('❌ Error during connection setup:', {
      error: err.message,
      stack: err.stack
    });
    socket.disconnect(true);
  }
});

// Enhanced emit endpoint with logging
app.post('/emit', authenticateAdminOnly, async (req, res) => {
  console.log('📤 Emit request received:', {
    body: req.body,
    headers: req.headers
  });

  const { to, event, data } = req.body;
  let targetEmail = to;
  
  if (process.env.NODE_ENV === 'development' && !targetEmail) {
    console.log('🛠️  Development mode - extracting email from JWT');
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        console.log('🔑 Verifying JWT for email extraction');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        targetEmail = decoded.email;
        console.log('✅ Extracted email from JWT:', targetEmail);
      } catch (err) {
        console.error('❌ JWT verification failed:', err.message);
        return res.status(401).json({ error: 'Invalid token' });
      }
    }
  }

  if (!targetEmail) {
    console.error('❌ No target email specified');
    return res.status(400).json({ error: 'No target specified' });
  }

  console.log(`📨 Emitting event "${event}" to:`, targetEmail);
  io.to(targetEmail).emit(event, data);
  
  console.log('✅ Event emitted successfully');
  res.status(200).send({ success: true });
});

 // Function to listen for snooze notifications
 async function setupSnoozeListener() {
  const client = await pool.connect(); // get a dedicated connection

  await client.query('LISTEN email_snoozed');
  console.log('👂 Listening for email_snoozed...');

  client.on('notification', async (msg) => {
    if (msg.channel === 'email_snoozed') {
      console.log('📩 Snoozed event received:', msg.payload);

      try {
        const data = JSON.parse(msg.payload);
        const delay = new Date(data.snoozed_until) - new Date();
        console.log(`⏳ Scheduling unsnooze in ${delay}ms`);

        if (delay > 0) {
          setTimeout(() => {
            (async () => {
              await unsnoozeEmail(data.email_id, data.user_id, data.original_message_type);
            })();
          }, delay);
        } else {
          await unsnoozeEmail(data.email_id, data.user_id, data.original_message_type);
        }
      } catch (err) {
        console.error('❌ Failed to process notification:', err);
      }
    }
  });

  client.on('error', err => {
    console.error('❌ Listener error:', err);
  });
}



async function unsnoozeEmail(emailId, userId) {
  try {
    // Step 1: Get the permanent original folder from message_type
    const emailResult = await pool.query(
      `SELECT message_type FROM mailboxes WHERE id = $1 AND user_id = $2`,
      [emailId, userId]
    );

    if (emailResult.rowCount === 0 || !emailResult.rows[0].message_type) {
      console.warn(`⚠️ No message_type found for email ${emailId}`);
      return;
    }

    const originalFolder = emailResult.rows[0].message_type;

    // Step 2: Get the folder_id for the original folder
    const folderResult = await pool.query(
      `SELECT folder_id FROM folders WHERE user_id = $1 AND type = $2 LIMIT 1`,
      [userId, originalFolder]
    );

    if (folderResult.rowCount === 0) {
      console.warn(`⚠️ Folder type "${originalFolder}" not found for user ${userId}`);
      return;
    }

    const folderId = folderResult.rows[0].folder_id;

    // Step 3: Restore folder and folder_id only
    const result = await pool.query(
      `UPDATE mailboxes
       SET 
         folder = $1,
         folder_id = $2,
         is_snoozed = false,
         snoozed_until = NULL,
         updated_at = NOW()
       WHERE id = $3 AND user_id = $4`,
      [originalFolder, folderId, emailId, userId]
    );

    if (result.rowCount === 1) {
      console.log(`✅ Email ${emailId} unsnoozed to "${originalFolder}"`);
    } else {
      console.warn(`⚠️ Email ${emailId} not updated`);
    }

  } catch (err) {
    console.error(`❌ Error unsnoozing email ${emailId}:`, err);
  }
}








// Call this when your app starts
setupSnoozeListener();


// Run every hour to catch any missed unsnoozes
setInterval(async () => {
  try {
      const result = await pool.query(`
          WITH unsnoozed AS (
              UPDATE mailboxes
              SET 
                  folder = message_type,
                  message_type = NULL,
                  updated_at = NOW()
              WHERE 
                  folder = 'Snoozed' AND
                  message_type IS NOT NULL AND
                  -- Assuming you have a snoozed_until column or similar
                  -- If not, you'll need to track this separately
                  snoozed_until <= NOW()
              RETURNING id, user_id, message_type AS original_folder
          )
          SELECT COUNT(*) as count FROM unsnoozed
      `);
      
      if (result.rows[0].count > 0) {
          console.log(`Unsnoozed ${result.rows[0].count} emails`);
      }
  } catch (err) {
      console.error('Error in snooze fallback check:', err);
  }
}, 3600000); // Every hour
  





server.listen(process.env.PORT, (err)=>{
    if(!err){
        console.log("App listening on PORT: ", process.env.PORT)
    }else{
        console.log("Error in starting the server ", err)
    }
})