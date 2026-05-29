const express = require("express");
const router = express.Router();
const db = require("../db");
const auth = require("../middlewares/auth");
const isAdmin = require("../middlewares/isAdmin");

/**
 * =========================
 * POST /api/orders
 * Tạo đơn hàng
 * =========================
 */
router.post("/", auth, async (req, res) => {
  console.log("--- Bắt đầu xử lý đơn hàng ---");
  const conn = await db.getConnection();

  try {
    const { items, coupon_code, note, address, fullname, phone } = req.body;
    console.log(fullname);

    const user_id = req.user?.id || null;

    // 1️⃣ VALIDATION CƠ BẢN (Không cần DB)
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ message: "Đơn hàng không có sản phẩm nào." });
    }
    if (!address || !phone) {
      return res.status(400).json({
        message: "Vui lòng cung cấp địa chỉ và số điện thoại giao hàng.",
      });
    }

    await conn.beginTransaction();

    // 2️⃣ KIỂM TRA TỒN KHO (Check trước khi ghi)
    let totalAmount = 0;
    const productChecks = [];

    for (const item of items) {
      const [rows] = await conn.query(
        "SELECT id, title, stock, sale_price FROM books WHERE id = ? FOR UPDATE",
        [item.product_id],
      );
      const product = rows[0];

      if (!product) {
        throw new Error(`Sản phẩm ID ${item.product_id} không tồn tại.`);
      }
      if (product.stock < item.quantity) {
        throw new Error(
          `Sách '${product.title}' hiện chỉ còn ${product.stock} cuốn.`,
        );
      }

      const price = parseFloat(product.sale_price);
      const qty = parseInt(item.quantity);
      const itemTotal = price * qty;
      totalAmount += itemTotal;

      productChecks.push({
        ...product,
        order_qty: qty,
        itemTotal: itemTotal,
      });
    }

    // 3️⃣ KIỂM TRA COUPON (Nếu có)
    let discountAmount = 0;
    let couponId = null;

    if (coupon_code) {
      const [coupons] = await conn.query(
        "SELECT * FROM coupons WHERE code = ? AND status = 1 AND quantity > 0 AND expired_at >= CURDATE() FOR UPDATE",
        [coupon_code],
      );
      const coupon = coupons[0];

      if (!coupon) throw new Error("Mã giảm giá không hợp lệ hoặc đã hết hạn.");
      if (totalAmount < coupon.min_order_value) {
        throw new Error(
          `Đơn hàng tối thiểu ${coupon.min_order_value.toLocaleString()}đ để dùng mã này.`,
        );
      }

      discountAmount =
        coupon.discount_type === "percent"
          ? Math.floor((totalAmount * coupon.discount_value) / 100)
          : parseFloat(coupon.discount_value);

      couponId = coupon.id;
    }

    const finalAmount = Math.max(0, totalAmount - discountAmount);

    // -------------------------------------------------------------
    // 4️⃣ THỰC THI (Sau khi tất cả các bước check ở trên đã PASS)
    // -------------------------------------------------------------

    // A. Cập nhật thông tin User (Nếu có đăng nhập)
    if (user_id) {
      await conn.query(
        "UPDATE users SET address = ?, phone = ?, full_name = ? WHERE id = ?",
        [address, phone, fullname, user_id],
      );
    }

    // B. Trừ số lượng Coupon
    if (couponId) {
      await conn.query(
        "UPDATE coupons SET quantity = quantity - 1 WHERE id = ?",
        [couponId],
      );
    }

    // C. Tạo Đơn hàng mới
    const orderCode = "OD" + Date.now();
    const [orderResult] = await conn.query(
      `INSERT INTO orders 
        (user_id, order_code, total_amount, discount_amount, final_amount, coupon_id, note, status, payment, address, phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, "pending", "cod", ?, ?)`,
      [
        user_id,
        orderCode,
        totalAmount,
        discountAmount,
        finalAmount,
        couponId,
        note,
        address,
        phone,
      ],
    );

    const orderId = orderResult.insertId;

    // D. Lưu chi tiết đơn hàng & Trừ kho
    for (const p of productChecks) {
      // Trừ kho
      await conn.query("UPDATE books SET stock = stock - ? WHERE id = ?", [
        p.order_qty,
        p.id,
      ]);

      // Lưu item
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, product_name, price, quantity, total)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, p.id, p.title, p.sale_price, p.order_qty, p.itemTotal],
      );
    }

    await conn.commit();
    res.json({
      success: true,
      message: "Đặt hàng thành công!",
      order_id: orderId,
    });
  } catch (err) {
    await conn.rollback();
    console.error("--- LỖI ORDER ---", err.message);
    res.status(400).json({ message: err.message });
  } finally {
    conn.release();
  }
});
/**
 * =========================
 * GET /api/orders
 * Admin: danh sách đơn (phân trang + lọc)
 * =========================
 */
router.get("/", auth, isAdmin, async (req, res) => {
  try {
    let { page = 1, limit = 10, status, keyword } = req.query;

    page = Number(page);
    limit = Number(limit);

    const offset = (page - 1) * limit;

    let where = "WHERE 1=1";
    const params = [];

    // =========================
    // FILTER STATUS
    // =========================
    if (status) {
      where += " AND o.status = ?";
      params.push(status);
    }

    // =========================
    // SEARCH
    // =========================
    if (keyword) {
      where += `
        AND (
          o.order_code LIKE ?
          OR u.full_name LIKE ?
          OR u.email LIKE ?
          OR u.phone LIKE ?
        )
      `;

      params.push(
        `%${keyword}%`,
        `%${keyword}%`,
        `%${keyword}%`,
        `%${keyword}%`,
      );
    }

    // =========================
    // GET ORDERS
    // =========================
    const [orders] = await db.query(
      `
      SELECT
        o.id,
        o.user_id,
        o.order_code,
        o.total_amount,
        o.discount_amount,
        o.final_amount,
        o.status,
        o.note,
        o.created_at,

        u.full_name AS customer_name,
        u.email AS customer_email,
        u.phone AS customer_phone,

        c.code AS coupon_code

      FROM orders o

      LEFT JOIN users u
        ON o.user_id = u.id

      LEFT JOIN coupons c
        ON o.coupon_id = c.id

      ${where}

      ORDER BY o.created_at DESC

      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset],
    );

    // =========================
    // COUNT PAGINATION
    // =========================
    const [[countResult]] = await db.query(
      `
      SELECT COUNT(*) AS total

      FROM orders o

      LEFT JOIN users u
        ON o.user_id = u.id

      ${where}
      `,
      params,
    );

    // =========================
    // FULL STATISTICS
    // KHÔNG LIMIT / OFFSET
    // =========================
    const [[statistics]] = await db.query(
      `
      SELECT

        COUNT(*) AS totalOrders,

        SUM(
          CASE
            WHEN o.status = 'pending'
            THEN 1
            ELSE 0
          END
        ) AS pendingOrders,

        SUM(
          CASE
            WHEN o.status = 'paid'
            THEN 1
            ELSE 0
          END
        ) AS paidOrders,

        SUM(
          CASE
            WHEN o.status = 'shipping'
            THEN 1
            ELSE 0
          END
        ) AS shippingOrders,

        SUM(
          CASE
            WHEN o.status = 'completed'
            THEN 1
            ELSE 0
          END
        ) AS completedOrders,

        SUM(
          CASE
            WHEN o.status = 'cancelled'
            THEN 1
            ELSE 0
          END
        ) AS cancelledOrders,

        COALESCE(
          SUM(
            CASE
              WHEN o.status = 'completed'
              THEN o.final_amount
              ELSE 0
            END
          ),
          0
        ) AS totalRevenue

      FROM orders o

      LEFT JOIN users u
        ON o.user_id = u.id

      ${where}
      `,
      params,
    );

    // =========================
    // RESPONSE
    // =========================
    res.json({
      data: orders,

      pagination: {
        total: countResult.total,
        page,
        limit,
        totalPages: Math.ceil(countResult.total / limit),
      },

      statistics,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Server error",
    });
  }
});

/**
 * =========================
 * GET /api/orders/my
 * User: đơn hàng của tôi
 * =========================
 */
router.get("/my", auth, async (req, res) => {
  const userId = req.user.id;

  const [orders] = await db.query(
    `SELECT * FROM orders 
     WHERE user_id = ?
     ORDER BY created_at DESC`,
    [userId],
  );

  res.json(orders);
});

/**
 * =========================
 * GET /api/orders/:id
 * Chi tiết đơn hàng
 * =========================
 */
router.get("/:id", auth, async (req, res) => {
  try {
    const orderId = req.params.id;

    /* ======================
       ORDER + USER + COUPON
    ====================== */
    const [[order]] = await db.query(
      `
      SELECT
        o.id,
        o.user_id,
        o.order_code,
        o.total_amount,
        o.discount_amount,
        o.final_amount,
        o.status,
        o.note,
        o.pay_url,
        o.created_at,
        o.payment,

        u.full_name AS customer_name,
        u.email AS customer_email,
        u.phone AS customer_phone,

        c.code AS coupon_code,
        c.discount_type,
        c.discount_value

      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      LEFT JOIN coupons c ON o.coupon_id = c.id
      WHERE o.id = ?
      `,
      [orderId],
    );

    if (!order) {
      return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
    }

    /* ======================
       PHÂN QUYỀN
    ====================== */
    if (req.user.role !== "admin" && order.user_id !== req.user.id) {
      return res.status(403).json({ message: "Không có quyền truy cập" });
    }

    /* ======================
       ORDER ITEMS
    ====================== */
    const [items] = await db.query(
      `
      SELECT
        id,
        product_id,
        product_name,
        price,
        quantity,
        total,
        created_at
      FROM order_items
      WHERE order_id = ?
      `,
      [orderId],
    );

    /* ======================
       PAYMENTS
    ====================== */
    const [payments] = await db.query(
      `
      SELECT
        id,
        method,
        amount,
        status,
        created_at
      FROM payments
      WHERE order_id = ?
      `,
      [orderId],
    );

    res.json({
      order,
      items,
      payments,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * =========================
 * PUT /api/orders/:id/status
 * Admin cập nhật trạng thái
 * =========================
 */
router.put("/:id/status", auth, isAdmin, async (req, res) => {
  const { status } = req.body;
  const allowStatus = ["pending", "paid", "shipping", "completed", "cancelled"];

  if (!allowStatus.includes(status)) {
    return res.status(400).json({ message: "Trạng thái không hợp lệ" });
  }

  await db.query("UPDATE orders SET status = ? WHERE id = ?", [
    status,
    req.params.id,
  ]);

  res.json({ message: "Cập nhật trạng thái thành công" });
});

/**
 * =========================
 * PUT /api/orders/:id/cancel
 * User hủy đơn (khi pending)
 * =========================
 */
router.put("/:id/cancel", auth, async (req, res) => {
  const orderId = req.params.id;

  const [[order]] = await db.query("SELECT * FROM orders WHERE id = ?", [
    orderId,
  ]);

  if (!order) {
    return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
  }

  if (order.user_id !== req.user.id) {
    return res.status(403).json({ message: "Không có quyền hủy đơn" });
  }

  if (order.status !== "pending") {
    return res.status(400).json({ message: "Không thể hủy đơn này" });
  }

  await db.query("UPDATE orders SET status = 'cancelled' WHERE id = ?", [
    orderId,
  ]);

  res.json({ message: "Hủy đơn hàng thành công" });
});

module.exports = router;
