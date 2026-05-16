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
  console.log("Dữ liệu nhận được:", JSON.stringify(req.body, null, 2));

  const conn = await db.getConnection();

  try {
    // 1️⃣ Lấy thêm trường address và fullname/phone từ body (React gửi lên)
    const { items, coupon_code, note, address, fullname, phone } = req.body;
    const user_id = req.user?.id || null;

    // Kiểm tra đầu vào cơ bản
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Đơn hàng không có sản phẩm nào." });
    }

    if (!address) {
      return res.status(400).json({ message: "Vui lòng cung cấp địa chỉ giao hàng." });
    }

    await conn.beginTransaction();

    // 2️⃣ Cập nhật thông tin vào bảng USER (Lưu địa chỉ/SĐT mới nhất cho khách)
    if (user_id) {
      console.log(`Cập nhật thông tin mới nhất cho User ID: ${user_id}`);
      await conn.query(
        "UPDATE users SET address = ?, phone = ? WHERE id = ?",
        [address, phone, user_id]
      );
    }

    // 3️⃣ Tính toán và làm sạch dữ liệu items
    let totalAmount = 0;
    const sanitizedItems = items.map((item, index) => {
      const p_id = parseInt(item.product_id);
      const p_price = parseFloat(item.price);
      const p_qty = parseInt(item.quantity);
      const p_name = item.product_name || `Sản phẩm ${index + 1}`;

      if (isNaN(p_id) || isNaN(p_price) || isNaN(p_qty)) {
        throw new Error(`Dữ liệu sản phẩm tại dòng ${index + 1} không hợp lệ.`);
      }

      const itemTotal = p_price * p_qty;
      totalAmount += itemTotal;

      return {
        product_id: p_id,
        product_name: p_name,
        price: p_price,
        quantity: p_qty,
        total: itemTotal
      };
    });

    // 4️⃣ Xử lý Coupon
    let discountAmount = 0;
    let couponId = null;

    if (coupon_code) {
      const [coupons] = await conn.query(
        "SELECT * FROM coupons WHERE code = ? AND status = 1 AND quantity > 0 AND expired_at >= CURDATE()",
        [coupon_code]
      );
      const coupon = coupons[0];

      if (!coupon) {
        throw new Error("Mã giảm giá không hợp lệ hoặc đã hết hạn.");
      }

      if (totalAmount < coupon.min_order_value) {
        throw new Error(`Đơn hàng tối thiểu ${coupon.min_order_value.toLocaleString()}đ để dùng mã này.`);
      }

      if (coupon.discount_type === "percent") {
        discountAmount = Math.floor((totalAmount * coupon.discount_value) / 100);
      } else {
        discountAmount = parseFloat(coupon.discount_value);
      }
      couponId = coupon.id;

      await conn.query("UPDATE coupons SET quantity = quantity - 1 WHERE id = ?", [couponId]);
    }

    const finalAmount = totalAmount - discountAmount;

    // 5️⃣ Lưu bảng orders (Lưu kèm địa chỉ cụ thể vào đơn hàng)
    const [orderResult] = await conn.query(
      `INSERT INTO orders 
        (user_id, order_code, total_amount, discount_amount, final_amount, coupon_id, note,status, payment)
       VALUES (?, ?, ?, ?, ?, ?, ?, "pending","cod")`,
      [
        user_id, 
        "OD" + Date.now(), 
        totalAmount, 
        discountAmount, 
        finalAmount, 
        couponId || null, 
        note || null, 
      ]
    );

    const orderId = orderResult.insertId;

    // 6️⃣ Xử lý từng Item (Kiểm tra kho & Lưu order_items)
    for (const item of sanitizedItems) {
      const [products] = await conn.query(
        "SELECT stock, title FROM books WHERE id = ? FOR UPDATE",
        [item.product_id]
      );
      const product = products[0];

      if (!product || product.stock < item.quantity) {
        throw new Error(`Sản phẩm '${product?.title || 'Unknown'}' không đủ hàng.`);
      }

      // Trừ kho
      await conn.query("UPDATE books SET stock = stock - ? WHERE id = ?", [item.quantity, item.product_id]);

      // Lưu chi tiết
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, product_name, price, quantity, total)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, item.product_id, item.product_name, item.price, item.quantity, item.total]
      );
    }

    await conn.commit();
    console.log("--- Đặt hàng & Cập nhật địa chỉ thành công! ---");

    res.json({
      success: true,
      message: "Đặt hàng thành công",
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

    if (status) {
      where += " AND o.status = ?";
      params.push(status);
    }

    if (keyword) {
      where += " AND (o.order_code LIKE ? OR u.full_name LIKE ? OR u.email LIKE ?)";
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    /* =======================
       QUERY DATA
    ======================= */
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
      LEFT JOIN users u ON o.user_id = u.id
      LEFT JOIN coupons c ON o.coupon_id = c.id

      ${where}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    /* =======================
       QUERY COUNT
    ======================= */
    const [[count]] = await db.query(
      `
      SELECT COUNT(*) total
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      ${where}
      `,
      params
    );

    res.json({
      data: orders,
      total: count.total,
      page,
      limit,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
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
    [userId]
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
      [orderId]
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
      [orderId]
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
      [orderId]
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
  const allowStatus = [
    "pending",
    "paid",
    "shipping",
    "completed",
    "cancelled",
  ];

  if (!allowStatus.includes(status)) {
    return res.status(400).json({ message: "Trạng thái không hợp lệ" });
  }

  await db.query(
    "UPDATE orders SET status = ? WHERE id = ?",
    [status, req.params.id]
  );

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

  const [[order]] = await db.query(
    "SELECT * FROM orders WHERE id = ?",
    [orderId]
  );

  if (!order) {
    return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
  }

  if (order.user_id !== req.user.id) {
    return res.status(403).json({ message: "Không có quyền hủy đơn" });
  }

  if (order.status !== "pending") {
    return res.status(400).json({ message: "Không thể hủy đơn này" });
  }

  await db.query(
    "UPDATE orders SET status = 'cancelled' WHERE id = ?",
    [orderId]
  );

  res.json({ message: "Hủy đơn hàng thành công" });
});

module.exports = router;
