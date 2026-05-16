// const mysql = require("mysql2");

// const db = mysql.createConnection({
//   host: "localhost",
//   user: "root",
//   password: "",       // mật khẩu MySQL
//   database: "quanly_sach"
// });

// db.connect(err => {
//   if (err) {
//     console.error("❌ Kết nối MySQL thất bại:", err);
//   } else {
//     console.log("✅ Đã kết nối MySQL");
//   }
// });

// module.exports = db;
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "quanly_sach",
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = pool;
