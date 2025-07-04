// const {Pool} = require("pg");
// require("dotenv").config();

// console.log(process.env.HOST)

// const pool = new Pool({
//     user: process.env.DB_USER,
//     host: process.env.HOST,
//     database: process.env.DATABASE,
//     password: process.env.DB_PASS,
//     port: process.env.DB_PORT
// })


// module.exports = pool;

const { Pool } = require("pg");
require("dotenv").config();

// Use connection string from environment variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Supabase requires SSL but allows self-signed certs
  }
});

// Test the connection
pool.query('SELECT current_database()')
  .then(res => console.log('✅ Connected to database:', res.rows[0].current_database))
  .catch(err => console.error('❌ Database connection error:', err));

module.exports = pool;