require('dotenv').config();
const jwt = require('jsonwebtoken');

const authenticateAdminOnly = (req, res, next) => {
  console.log('🔐 Starting admin authentication process');
  
  // 1. Get the Authorization header
  console.log('🔍 Checking for Authorization header');
  const authHeader = req.headers.authorization;
  console.log('📋 Authorization header:', authHeader || 'Not found');
  
  if (!authHeader) {
    console.error('❌ Authorization header missing');
    return res.status(401).json({ error: "Authorization header missing" });
  }

  // 2. Check header format
  console.log('🔍 Validating Authorization header format');
  const parts = authHeader.split(' ');
  console.log('📋 Header parts:', parts);
  
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    console.error('❌ Invalid Authorization header format');
    return res.status(401).json({ 
      error: "Authorization header format should be: Bearer <token>" 
    });
  }

  const token = parts[1];
  console.log('🔑 Extracted token in Auth Admin Middileware:', token ? 'Present ' + token : 'Missing');
  
  // 3. Verify the token
  try {
    console.log('🔍 Verifying token in', process.env.NODE_ENV, 'environment');
    
    if (process.env.NODE_ENV === 'development') {
      console.log('🛠️  Development mode - verifying JWT');
      const decoded = jwt.verify(token, process.env.ADMIN_SECRET);
      console.log('✅ JWT decoded successfully:', decoded);
      
      // Additional check for admin role if needed
      if (decoded.role && decoded.role !== 'admin') {
        console.error('❌ Insufficient privileges - Admin role required');
        return res.status(403).json({ error: "Admin access required" });
      }
      
      req.user = decoded;
      console.log('👤 User set in request:', req.user);
    } else {
      console.log('🚀 Production mode - verifying static token');
      if (token !== process.env.ADMIN_SECRET) {
        console.error('❌ Invalid admin token in production');
        return res.status(401).json({ error: "Invalid admin token" });
      }
      console.log('✅ Static token verified successfully');
    }
    
    console.log('🟢 Authentication successful, proceeding to next middleware');
    next();
  } catch (err) {
    console.error('❌ JWT verification error:', {
      name: err.name,
      message: err.message,
      stack: err.stack
    });
    
    if (err.name === 'JsonWebTokenError') {
      console.error('❌ Invalid token format');
      return res.status(401).json({ 
        error: "Invalid token",
        details: err.message 
      });
    }
    
    if (err.name === 'TokenExpiredError') {
      console.error('⌛ Token expired');
      return res.status(401).json({ 
        error: "Token expired",
        details: err.message 
      });
    }
    
    console.error('❗ Unexpected authentication error');
    return res.status(401).json({ 
      error: "Authentication failed",
      details: err.message 
    });
  }
};

console.log('🔄 Admin authentication middleware initialized');
module.exports = authenticateAdminOnly;