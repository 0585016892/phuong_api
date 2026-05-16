const express = require("express");
const router = express.Router();
const db = require("../db");
const auth = require("../middlewares/auth");
const isAdmin = require("../middlewares/isAdmin");

router.get("/",  async (req, res) => {
  try {
    // ===== OVERVIEW =====
    const [[revenue]] = await db.query(`
      SELECT IFNULL(SUM(final_amount),0) AS total
      FROM orders
      WHERE status = 'completed'
    `);

    const [[orderCount]] = await db.query(`
      SELECT COUNT(*) AS total FROM orders
    `);

    const [[userCount]] = await db.query(`
      SELECT COUNT(*) AS total
      FROM users
      WHERE role = 'user'
    `);

    const [[lowStock]] = await db.query(`
      SELECT COUNT(*) AS total
      FROM books
      WHERE stock <= 5
    `);

    // ===== REVENUE DAILY =====
    const [dailyRevenue] = await db.query(`
      SELECT 
        DATE(created_at) AS date,
        SUM(final_amount) AS revenue
      FROM orders
      WHERE status = 'completed'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
      LIMIT 7
    `);

    // ===== ORDER STATUS =====
    const [orderStatus] = await db.query(`
      SELECT status, COUNT(*) AS total
      FROM orders
      GROUP BY status
    `);

    // ===== TOP PRODUCTS =====
    const [topProducts] = await db.query(`
      SELECT 
        oi.product_id,
        oi.product_name,
        SUM(oi.quantity) AS sold
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.status = 'paid'
      GROUP BY oi.product_id
      ORDER BY sold DESC
      LIMIT 5
    `);

    // ===== LATEST ORDERS =====
    const [latestOrders] = await db.query(`
      SELECT id, order_code, final_amount, status, created_at
      FROM orders
      ORDER BY created_at DESC
      LIMIT 5
    `);

    res.json({
      overview: {
        revenue: revenue.total,
        orders: orderCount.total,
        users: userCount.total,
        lowStock: lowStock.total,
      },
      charts: {
        dailyRevenue: dailyRevenue.reverse(),
        orderStatus,
      },
      tables: {
        topProducts,
        latestOrders,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
module.exports = router;
