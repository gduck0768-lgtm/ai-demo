const { Pool } = require("pg");

console.log("DATABASE_URL =", process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.query("SELECT 1")
  .then(() => {
    console.log("PostgreSQL 数据库连接成功");
  })
  .catch((err) => {
    console.error("PostgreSQL 数据库连接失败:", err);
  });

module.exports = pool;