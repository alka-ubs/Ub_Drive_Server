const {Pool} = require("pg");
require("dotenv").config();

console.log(process.env.HOST)

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.HOST,
    database: process.env.DATABASE,
    password: process.env.DB_PASS,
    port: process.env.DB_PORT
})


module.exports = pool;