const express = require("express");
const db = require("../db"); // mysql2/promise pool
const router = express.Router();

/* ================= CREATE ================= */
router.post("/", async (req, res) => {
  try {
    const {
      code,
      discount_type,
      discount_value,
      max_discount,
      min_order_value,
      quantity,
      expired_at,
    } = req.body;

    await db.query(
      `
      INSERT INTO coupons
      (code, discount_type, discount_value, max_discount, min_order_value, quantity, expired_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        code,
        discount_type,
        discount_value,
        max_discount,
        min_order_value,
        quantity,
        expired_at,
      ]
    );

    res.json({ message: "✅ Thêm mã giảm giá thành công" });
  } catch (err) {
    console.error(err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Mã đã tồn tại" });
    }
    res.status(500).json({ message: "Server error" });
  }
});

/* ================= UPDATE ================= */
router.put("/:id", async (req, res) => {
  try {
    const {
      code,
      discount_type,
      discount_value,
      max_discount,
      min_order_value,
      quantity,
      status,
      expired_at,
    } = req.body;

    const { id } = req.params;

    const [result] = await db.query(
      `
      UPDATE coupons SET
        code = ?,
        discount_type = ?,
        discount_value = ?,
        max_discount = ?,
        min_order_value = ?,
        quantity = ?,
        status = ?,
        expired_at = ?
      WHERE id = ?
      `,
      [
        code,
        discount_type,
        discount_value,
        max_discount,
        min_order_value,
        quantity,
        status,
        expired_at,
        id,
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy mã" });
    }

    res.json({ message: "✅ Cập nhật mã thành công" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ================= DELETE ================= */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await db.query(
      "DELETE FROM coupons WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy mã" });
    }

    res.json({ message: "🗑️ Đã xoá mã giảm giá" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ================= LIST + SEARCH + FILTER ================= */
router.get("/", async (req, res) => {
  try {
    let { page = 1, limit = 10, keyword = "", status } = req.query;

    page = Number(page);
    limit = Number(limit);
    const offset = (page - 1) * limit;

    let where = "WHERE 1=1";
    const params = [];

    if (keyword) {
      where += " AND code LIKE ?";
      params.push(`%${keyword}%`);
    }

    if (status !== undefined) {
      where += " AND status = ?";
      params.push(status);
    }

    const sqlData = `
      SELECT *
      FROM coupons
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    const sqlCount = `
      SELECT COUNT(*) AS total
      FROM coupons
      ${where}
    `;

    const [[{ total }]] = await db.query(sqlCount, params);
    const [data] = await db.query(sqlData, [...params, limit, offset]);

    res.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      data,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ================= DETAIL ================= */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query(
      "SELECT * FROM coupons WHERE id = ?",
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Không tìm thấy mã" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ================= APPLY COUPON ================= */
router.post("/apply", async (req, res) => {
  try {
    const { code, order_total } = req.body;

    const [rows] = await db.query(
      "SELECT * FROM coupons WHERE code = ?",
      [code]
    );

    if (!rows.length) {
      return res.status(400).json({ message: "Mã không tồn tại" });
    }

    const c = rows[0];
    const today = new Date();

    if (!c.status) {
      return res.status(400).json({ message: "Mã đã bị tắt" });
    }

    if (c.quantity <= 0) {
      return res.status(400).json({ message: "Mã đã hết lượt" });
    }

    if (c.expired_at && today > new Date(c.expired_at)) {
      return res.status(400).json({ message: "Mã đã hết hạn" });
    }

    if (order_total < c.min_order_value) {
      return res.status(400).json({
        message: `Đơn tối thiểu ${c.min_order_value} mới được dùng`,
      });
    }

    let discount = 0;

    if (c.discount_type === "percent") {
      discount = (order_total * c.discount_value) / 100;
      if (c.max_discount) {
        discount = Math.min(discount, c.max_discount);
      }
    } else {
      discount = c.discount_value;
    }

    res.json({
      discount,
      final_total: order_total - discount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
