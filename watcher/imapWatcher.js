const { ImapFlow } = require('imapflow');

// Connection pool
const connectionPool = new Map();

const startImapWatcher = async (email, password, socket) => {
  console.log(`🔍 Starting IMAP watcher for ${email}`);
  
  try {
    // Check for existing connection
    if (connectionPool.has(email)) {
      const existing = connectionPool.get(email);
      existing.sockets.add(socket.id);
      console.log(`♻️ Reusing existing connection for ${email}`);
      return existing.client;
    }

    console.log(`🆕 Creating new connection for ${email}`);
    
    const client = new ImapFlow({
      host: 'smtp.ubshq.com',
      port: 993,
      secure: true,
      auth: {
        user: email,
        pass: password
      },
      tls: {
        rejectUnauthorized: false
      },
      logger: false
    });

    // Store connection
    const sockets = new Set([socket.id]);
    connectionPool.set(email, { client, sockets });

    console.log(`🔗 Connecting to IMAP server...`);
    await client.connect();
    console.log(`✅ Connected to ${email}'s mailbox`);

    // Get mailbox lock
    console.log(`🔓 Locking INBOX...`);
    const lock = await client.getMailboxLock('INBOX');
    console.log(`📬 INBOX ready for ${email}`);

    // Start IDLE
    console.log(`👂 Starting IDLE listener...`);
    const idle = await client.idle(); // Note the await here
    
    // Handle new mail events
    client.on('mail', () => {
      console.log(`📨 New mail for ${email}`);
      socket.emit('new-mail', {
        message: 'New email arrived',
        email,
        timestamp: new Date().toISOString()
      });
    });

    // Handle errors
    client.on('error', err => {
      console.error(`💥 IMAP error:`, err);
      cleanupConnection(email);
    });

    // Handle disconnects
    socket.on('disconnect', async () => {
      console.log(`❌ Socket disconnected for ${email}`);
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        await cleanupConnection(email);
      }
    });

    return client;

  } catch (err) {
    console.error(`❌ IMAP setup failed:`, err);
    await cleanupConnection(email);
    socket.emit('imap-error', { 
      error: 'IMAP connection failed',
      details: err.message 
    });
    throw err;
  }
};

// Cleanup function
async function cleanupConnection(email) {
  if (!connectionPool.has(email)) return;

  console.log(`🧹 Cleaning up ${email}`);
  const { client } = connectionPool.get(email);

  try {
    if (client && client.connection && !client.connection.closed) {
      await client.logout();
      console.log(`✅ Closed connection for ${email}`);
    }
  } catch (err) {
    console.error(`⚠️ Cleanup error:`, err);
  } finally {
    connectionPool.delete(email);
    console.log(`🗑️ Removed ${email} from pool`);
  }
}

// Monitor connections
setInterval(() => {
  console.log('📊 Active connections:', {
    count: connectionPool.size,
    emails: [...connectionPool.keys()]
  });
}, 300000);

module.exports = startImapWatcher;