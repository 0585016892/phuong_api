const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const axios = require("axios");
const db = require("../db");
const auth = require("../middlewares/auth");

const partnerCode = "MOMO";
const accessKey = "F8BBA842ECF85";
const secretKey = "K951B6PE1waDMi640xX08PD3vg6EkVlz";
const MOMO_ENDPOINT = "https://test-payment.momo.vn/v2/gateway/api/create";

/* ================= 1. API TẠO THANH TOÁN ================= */
router.post("/momo", auth, async (req, res) => {
  const conn = await db.getConnection();

  console.log("========== CREATE MOMO ORDER ==========");
  console.log("BODY:", req.body);
  console.log("USER:", req.user);

  try {
    const { items, coupon_code, note, address, fullname, phone } = req.body;
    const user_id = req.user?.id;

    await conn.beginTransaction();
    console.log("✅ Begin transaction");

    // A. Tính toán tiền từ DB để chống hack giá
    let totalAmount = 0;
    const orderItems = [];

    for (const item of items) {
      console.log("🛒 Checking product:", item);

      const [rows] = await conn.query(
        "SELECT id, title, sale_price, stock FROM books WHERE id = ? FOR UPDATE",
        [item.product_id],
      );

      const product = rows[0];

      console.log("📦 Product from DB:", product);

      if (!product || product.stock < item.quantity) {
        console.log("❌ Not enough stock");
        throw new Error(`Sản phẩm ${product?.title} không đủ hàng.`);
      }

      totalAmount += product.sale_price * item.quantity;

      orderItems.push({
        ...product,
        qty: item.quantity,
      });
    }

    console.log("💰 Total amount:", totalAmount);

    // B. Tính Coupon
    let discountAmount = 0;
    let couponId = null;

    if (coupon_code) {
      console.log("🎟 Checking coupon:", coupon_code);

      const [cp] = await conn.query(
        "SELECT * FROM coupons WHERE code=? AND status=1",
        [coupon_code],
      );

      console.log("🎟 Coupon result:", cp[0]);

      if (cp[0]) {
        couponId = cp[0].id;

        discountAmount =
          cp[0].discount_type === "percent"
            ? (totalAmount * cp[0].discount_value) / 100
            : cp[0].discount_value;
      }
    }

    console.log("💸 Discount amount:", discountAmount);

    const finalAmount = Math.floor(totalAmount - discountAmount);
    const orderCode = "LIB" + Date.now();

    console.log("💵 Final amount:", finalAmount);
    console.log("🧾 Order code:", orderCode);

    // C. Lưu đơn hàng
    const [orderResult] = await conn.query(
      `INSERT INTO orders 
      (
        user_id,
        order_code,
        total_amount,
        discount_amount,
        final_amount,
        coupon_id,
        note,
        address,
        phone,
        fullname,
        status,
        payment
      ) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', 'momo')`,
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
        fullname,
      ],
    );

    const orderId = orderResult.insertId;

    console.log("✅ Order created:", orderId);

    // D. Lưu Items
    for (const item of orderItems) {
      console.log("📥 Insert order item:", item);

      await conn.query(
        `INSERT INTO order_items 
        (
          order_id,
          product_id,
          product_name,
          price,
          quantity,
          total
        ) 
        VALUES (?,?,?,?,?,?)`,
        [
          orderId,
          item.id,
          item.title,
          item.sale_price,
          item.qty,
          item.sale_price * item.qty,
        ],
      );
    }

    console.log("✅ Order items inserted");

    // E. Gọi API MoMo
    const amountStr = finalAmount.toString();
    const extraData = orderId.toString();

    const rawSignature = `accessKey=${accessKey}&amount=${amountStr}&extraData=${extraData}&ipnUrl=${process.env.NGROK_API}/api/payment/momo/ipn&orderId=${orderCode}&orderInfo=Payment&partnerCode=${partnerCode}&redirectUrl=${process.env.WEB_URL}/thanks&requestId=${orderCode}&requestType=payWithATM`;

    console.log("🔐 Raw signature:", rawSignature);

    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(rawSignature)
      .digest("hex");

    console.log("🔐 Signature:", signature);

    const momoPayload = {
      partnerCode,
      requestId: orderCode,
      amount: amountStr,
      orderId: orderCode,
      orderInfo: "Payment",
      redirectUrl: `${process.env.WEB_URL}/thanks`,
      ipnUrl: `https://e626-42-113-45-185.ngrok-free.app/api/payment/momo/ipn`,
      extraData,
      requestType: "payWithATM",
      signature,
      lang: "vi",
    };

    console.log("📤 MoMo payload:", momoPayload);

    const momoRes = await axios.post(MOMO_ENDPOINT, momoPayload);

    console.log("📥 MoMo response:", momoRes.data);

    // Lưu pay_url
    await conn.query("UPDATE orders SET pay_url = ? WHERE id = ?", [
      momoRes.data.payUrl,
      orderId,
    ]);

    console.log("✅ Pay URL saved");

    await conn.commit();

    console.log("✅ Transaction committed");
    console.log("======================================");

    res.json({
      payUrl: momoRes.data.payUrl,
    });
  } catch (err) {
    console.log("❌ MOMO ERROR:", err);

    if (err.response) {
      console.log("❌ MOMO RESPONSE:", err.response.data);
    }

    if (conn) await conn.rollback();

    console.log("↩️ Transaction rollback");
    console.log("======================================");

    res.status(400).json({
      message: err.message,
      error: err.response?.data || null,
    });
  } finally {
    conn.release();
    console.log("🔌 Connection released");
  }
});

/* ================= 2. API IPN (CẬP NHẬT TRẠNG THÁI PAID) ================= */
/* ================= API IPN (SERVER-TO-SERVER) ================= */
router.post("/momo/ipn", async (req, res) => {
  console.log("======================================");
  console.log(">>> NHẬN IPN TỪ MOMO");
  console.log(req.body);

  const conn = await db.getConnection();

  try {
    const {
      resultCode,
      extraData,
      orderId: momoOrderCode,
      transId,
      amount,
    } = req.body;

    const orderId = extraData;

    if (!orderId) {
      console.log("❌ Không có extraData");
      return res.status(400).json({
        message: "Missing extraData",
      });
    }

    await conn.beginTransaction();

    // LOCK ĐƠN HÀNG
    const [orders] = await conn.query(
      `SELECT * FROM orders 
       WHERE id = ? 
       FOR UPDATE`,
      [orderId],
    );

    const order = orders[0];

    if (!order) {
      console.log("❌ Không tìm thấy đơn hàng");
      await conn.rollback();

      return res.status(404).json({
        message: "Order not found",
      });
    }

    console.log("📦 Order DB:", order);

    // ĐÃ XỬ LÝ RỒI => BỎ QUA
    if (order.status === "paid") {
      console.log("⚠️ Đơn hàng đã paid trước đó");

      await conn.commit();

      return res.status(204).send();
    }

    /* ================= THANH TOÁN THÀNH CÔNG ================= */
    if (Number(resultCode) === 0) {
      console.log("✅ Thanh toán thành công");

      // Lấy danh sách sản phẩm
      const [items] = await conn.query(
        `SELECT product_id, quantity 
         FROM order_items 
         WHERE order_id = ?`,
        [orderId],
      );

      // Check stock lần cuối
      for (const item of items) {
        const [products] = await conn.query(
          `SELECT stock, title 
           FROM books 
           WHERE id = ? 
           FOR UPDATE`,
          [item.product_id],
        );

        const product = products[0];

        if (!product || product.stock < item.quantity) {
          throw new Error(
            `Sản phẩm ${product?.title || item.product_id} không đủ tồn kho`,
          );
        }
      }

      // Trừ kho
      for (const item of items) {
        await conn.query(
          `UPDATE books 
           SET stock = stock - ? 
           WHERE id = ?`,
          [item.quantity, item.product_id],
        );
      }

      // Nếu có coupon => trừ số lượng coupon
      if (order.coupon_id) {
        await conn.query(
          `UPDATE coupons 
           SET quantity = quantity - 1 
           WHERE id = ? 
           AND quantity > 0`,
          [order.coupon_id],
        );
      }

      // Update trạng thái PAID
      await conn.query(
        `UPDATE orders 
         SET 
           status = 'paid',
           momo_trans_id = ?,
           paid_at = NOW()
         WHERE id = ?`,
        [transId || null, orderId],
      );

      console.log("✅ UPDATE PAID SUCCESS");
    } else {

    /* ================= THANH TOÁN THẤT BẠI ================= */
      console.log("❌ Thanh toán thất bại:", resultCode);

      await conn.query(
        `UPDATE orders 
         SET status = 'pending_payment'
         WHERE id = ?`,
        [orderId],
      );
    }

    await conn.commit();

    console.log("✅ COMMIT SUCCESS");
    console.log("======================================");

    // MOMO yêu cầu trả 204
    return res.status(204).send();
  } catch (err) {
    console.error("❌ IPN ERROR:", err);

    if (conn) await conn.rollback();

    console.log("↩️ ROLLBACK");
    console.log("======================================");

    return res.status(500).json({
      message: err.message,
    });
  } finally {
    conn.release();
    console.log("🔌 RELEASE CONNECTION");
  }
});

module.exports = router;
