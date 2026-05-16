const express = require("express");
const router = express.Router();
const db = require("../db");
const auth = require("../middlewares/auth");
const isAdmin = require("../middlewares/isAdmin");

/**
 * =========================
 * POST /api/payments
 * Tạo payment cho đơn hàng
 * =========================
 */
router.post("/", auth, async (req, res) => {
  const { order_id, method, amount } = req.body;

  if (!order_id || !method || !amount) {
    return res.status(400).json({ message: "Thiếu dữ liệu thanh toán" });
  }

  // check order
  const [[order]] = await db.query(
    "SELECT * FROM orders WHERE id = ?",
    [order_id]
  );

  if (!order)
    return res.status(404).json({ message: "Đơn hàng không tồn tại" });

  // user chỉ trả đơn của mình
  if (req.user.role !== "admin" && order.user_id !== req.user.id) {
    return res.status(403).json({ message: "Không có quyền" });
  }

  await db.query(
    `INSERT INTO payments (order_id, method, amount, status)
     VALUES (?, ?, ?, 'success')`,
    [order_id, method, amount]
  );

  // update order status
  await db.query(
    "UPDATE orders SET status = 'paid' WHERE id = ?",
    [order_id]
  );

  res.json({ message: "💰 Thanh toán thành công" });
});

/**
 * =========================
 * GET /api/payments
 * Admin xem danh sách payment
 * =========================
 */
router.get("/", auth, isAdmin, async (req, res) => {
  const [rows] = await db.query(
    `SELECT p.*, o.order_code
     FROM payments p
     JOIN orders o ON p.order_id = o.id
     ORDER BY p.created_at DESC`
  );
  res.json(rows);
});

module.exports = router;
