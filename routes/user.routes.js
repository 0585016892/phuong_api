const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../db"); // mysql2/promise
const auth = require("../middlewares/auth");
const isAdmin = require("../middlewares/isAdmin");
const { generateToken } = require("../utils/jwt");

const router = express.Router();

/* ===================== REGISTER ===================== */
router.post("/register", async (req, res) => {
  try {
    // Chỉ lấy các thông tin cần thiết từ người dùng gửi lên
    const { full_name, email, phone, password } = req.body;

    // Kiểm tra dữ liệu đầu vào cơ bản (tùy chọn nhưng nên có)
    if (!full_name || !email || !password || !phone ) {
      return res.status(400).json({ message: "Vui lòng nhập đầy đủ thông tin bắt buộc" });
    }

    // Mã hóa mật khẩu
    const hash = await bcrypt.hash(password, 10);

    // Thực hiện chèn dữ liệu với giá trị mặc định trực tiếp trong câu lệnh SQL
    // role mặc định là 'user', status mặc định là 1
    await pool.query(
      `INSERT INTO users (full_name, email, phone, password, role, status)
       VALUES (?, ?, ?, ?, 'user', 1)`,
      [full_name, email, phone, hash]
    );

    res.json({ message: "Đăng ký thành công" });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    
    // Kiểm tra nếu lỗi do trùng Email (thường là mã lỗi 'ER_DUP_ENTRY' trong MySQL)
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: "Email hoặc số điện thoại đã tồn tại" });
    }
    
    res.status(500).json({ message: "Lỗi hệ thống, vui lòng thử lại sau" });
  }
});

/* ===================== LOGIN ===================== */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Tìm user chỉ bằng email để kiểm tra trạng thái sau đó
    const [rows] = await pool.query(
      "SELECT * FROM users WHERE email = ?",
      [email]
    );
  
    if (rows.length === 0) {
      return res.status(400).json({ message: "Email không tồn tại trong hệ thống" });
    }

    const user = rows[0];

    // 2. Kiểm tra mật khẩu trước
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Mật khẩu không chính xác" });
    }

    // 3. Kiểm tra trạng thái hoạt động (Status)
    // Giả sử 1 là hoạt động, 0 là bị khóa
    if (Number(user.status) !== 1) {
      return res.status(403).json({ message: "Tài khoản của bạn đã bị khóa. Vui lòng liên hệ Admin!" });
    }

    // 4. Kiểm tra quyền hạn (Role)
    // Nếu đây là API dành cho khách hàng, chỉ cho phép role 'user'
    if (user.role !== 'user') {
      return res.status(403).json({ message: "Bạn không có quyền truy cập vào khu vực dành cho khách hàng" });
    }

    // 5. Tạo Token nếu mọi điều kiện đều thỏa mãn
    const token = generateToken({
      id: user.id,
      role: user.role,
    });

    // 6. Trả về dữ liệu cần thiết
    res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status
      },
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ message: "Lỗi hệ thống, vui lòng thử lại sau" });
  }
});
router.post("/loginadmin", async (req, res) => {
  console.log("gọi ok ");
  
  try {
    const { email, password } = req.body;
    console.log(email);
    
    const [rows] = await pool.query(
      "SELECT * FROM users WHERE email = ? AND status = 1",
      [email]
    );

    if (rows.length === 0) {
      return res.status(400).json({ message: "Sai email hoặc mật khẩu" });
    }

    const user = rows[0];

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(400).json({ message: "Sai email hoặc mật khẩu" });
    }

    const token = generateToken({
      id: user.id,
      role: user.role,
    });

    res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ message: "Lỗi server" });
  }
});

/* ===================== ME ===================== */
router.get("/me", auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, full_name, email, phone, role, status, created_at
       FROM users WHERE id = ?`,
      [req.user.id]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Lỗi server" });
  }
});

/* ===================== GET ALL USERS (ADMIN) ===================== */
/* ===================== GET USERS (ADMIN | PAGINATION + SEARCH) ===================== */
router.get("/", auth, isAdmin, async (req, res) => {
  try {
    let {
      page = 1,
      limit = 10,
      keyword = "",
      status
    } = req.query;

    page = Number(page);
    limit = Number(limit);
    const offset = (page - 1) * limit;

    let where = " WHERE 1=1 ";
    const params = [];

    if (keyword) {
      where += `
        AND (
          full_name LIKE ?
          OR email LIKE ?
          OR phone LIKE ?
        )
      `;
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    if (status !== undefined) {
      where += " AND status = ? ";
      params.push(status);
    }

    const sqlData = `
      SELECT id, full_name, email, phone, role, status, created_at
      FROM users
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    const sqlCount = `
      SELECT COUNT(*) AS total
      FROM users
      ${where}
    `;

    const [[{ total }]] = await pool.query(sqlCount, params);
    const [users] = await pool.query(sqlData, [...params, limit, offset]);

    res.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      data: users
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Lỗi server" });
  }
});

/* ===================== TOGGLE STATUS USER (ADMIN) ===================== */
router.put("/:id/status", auth, isAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const { id } = req.params;

    const [result] = await pool.query(
      "UPDATE users SET status = ? WHERE id = ?",
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "User không tồn tại" });
    }

    res.json({ message: "✅ Cập nhật trạng thái user thành công" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Lỗi server" });
  }
});

/* ===================== GET USER BY ID (ADMIN) ===================== */
router.get("/:id", auth, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, full_name, email, phone, role, status
       FROM users WHERE id = ?`,
      [req.params.id]
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Lỗi server" });
  }
});

/* ===================== UPDATE USER (ADMIN) ===================== */
router.put("/:id", auth, isAdmin, async (req, res) => {
  try {
    const { full_name, phone, role, status } = req.body;

    await pool.query(
      `UPDATE users
       SET full_name = ?, phone = ?, role = ?, status = ?
       WHERE id = ?`,
      [full_name, phone, role, status, req.params.id]
    );

    res.json({ message: "✅ Cập nhật thành công" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Lỗi server" });
  }
});

/* ===================== CHANGE PASSWORD ===================== */
router.put("/change-password/me", auth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    const [rows] = await pool.query(
      "SELECT password FROM users WHERE id = ?",
      [req.user.id]
    );

    const ok = await bcrypt.compare(oldPassword, rows[0].password);
    if (!ok) {
      return res.status(400).json({ message: "Mật khẩu cũ không đúng" });
    }

    const hash = await bcrypt.hash(newPassword, 10);

    await pool.query(
      "UPDATE users SET password = ? WHERE id = ?",
      [hash, req.user.id]
    );

    res.json({ message: "🔐 Đổi mật khẩu thành công" });
  } catch (err) {
    res.status(500).json({ message: "Lỗi server" });
  }
});

/* ===================== DELETE (SOFT) ===================== */
router.delete("/:id", auth, isAdmin, async (req, res) => {
  try {
    await pool.query(
      "UPDATE users SET status = 0 WHERE id = ?",
      [req.params.id]
    );

    res.json({ message: "🗑️ Đã khoá user" });
  } catch (err) {
    res.status(500).json({ message: "Lỗi server" });
  }
});

module.exports = router;
