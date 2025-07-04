const jwt = require('jsonwebtoken');
require('dotenv').config();

// const authenticate = (req, res, next) => {
//   const token = req.headers.authorization?.split(" ")[1];
//   if (!token) return res.status(401).json({ error: "Token missing" });

//   try {
//     const decoded = jwt.verify(token, process.env.JWT_SECRET);
//     console.log(decoded, "JWT DECODED")
//     req.user = decoded; // { email: ..., id: ... }
//     next();
//   } catch (err) {
//     return res.status(401).json({ error: "Invalid or expired token" });
//   }
// };

const authenticate = (req, res, next) => {
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    // ✅ Session-based authentication (production)
    if (req.session?.userId) {
      req.user = {
        user_id: req.session.userId,
        email: req.session.email
      };
      return next();
    }
    return res.status(401).json({ error: "User not authenticated (session)" });
  }

  // ✅ JWT-based authentication (development or staging)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Missing or invalid token (dev mode)" });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // expected to include { user_id, email }
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};


module.exports = authenticate;
