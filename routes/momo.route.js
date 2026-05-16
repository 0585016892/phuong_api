const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const axios = require("axios");
const moment = require("moment");
const db = require("../db"); // file MySQL của bạn
const auth = require("../middlewares/auth");

router.post("/momo", auth, async (req, res) => {
  const conn = await db.getConnection();

  try {
    const { items, coupon_code, note, address, fullname, phone } = req.body;
    const user_id = req.user?.id || null;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Đơn hàng không có sản phẩm." });
    }

    await conn.beginTransaction();

    // 🔹 Cập nhật user
    if (user_id) {
      await conn.query(
        "UPDATE users SET address=?, phone=? WHERE id=?",
        [address, phone, user_id]
      );
    }

    // 🔹 Tính tiền
    let totalAmount = 0;
    const sanitizedItems = items.map((item) => {
      const total = Number(item.price) * Number(item.quantity);
      totalAmount += total;

      return {
        product_id: parseInt(item.product_id),
        product_name: item.product_name,
        price: parseFloat(item.price),
        quantity: parseInt(item.quantity),
        total
      };
    });

    // 🔹 Coupon
    let discountAmount = 0;
    let couponId = null;

    if (coupon_code) {
      const [coupons] = await conn.query(
        "SELECT * FROM coupons WHERE code=? AND status=1 AND quantity>0 AND expired_at>=CURDATE()",
        [coupon_code]
      );

      const coupon = coupons[0];
      if (!coupon) throw new Error("Mã giảm giá không hợp lệ.");

      if (coupon.discount_type === "percent") {
        discountAmount = Math.floor(totalAmount * coupon.discount_value / 100);
      } else {
        discountAmount = parseFloat(coupon.discount_value);
      }

      couponId = coupon.id;
      await conn.query(
        "UPDATE coupons SET quantity = quantity - 1 WHERE id=?",
        [couponId]
      );
    }

    const finalAmount = totalAmount - discountAmount;

    // 🔹 Tạo order_code
    const orderCode = "OD" + Date.now();

    const [orderResult] = await conn.query(
      `INSERT INTO orders 
        (user_id, order_code, total_amount, discount_amount, final_amount, coupon_id, note, status, payment)
       VALUES (?, ?, ?, ?, ?, ?, ?, "pending","momo")`,
      [
        user_id,
        orderCode,
        totalAmount,
        discountAmount,
        finalAmount,
        couponId,
        note
      ]
    );

    const orderId = orderResult.insertId;

    // 🔹 Trừ kho + lưu order_items
    for (const item of sanitizedItems) {
      const [products] = await conn.query(
        "SELECT stock, title FROM books WHERE id=? FOR UPDATE",
        [item.product_id]
      );

      const product = products[0];
      if (!product || product.stock < item.quantity) {
        throw new Error(`Sản phẩm '${product?.title}' không đủ hàng.`);
      }

      await conn.query(
        "UPDATE books SET stock = stock - ? WHERE id=?",
        [item.quantity, item.product_id]
      );

      await conn.query(
        `INSERT INTO order_items 
          (order_id, product_id, product_name, price, quantity, total)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          item.product_id,
          item.product_name,
          item.price,
          item.quantity,
          item.total
        ]
      );
    }

    await conn.commit();

    /* ================= MOMO ================= */

    const partnerCode = "MOMO";
    const accessKey = "F8BBA842ECF85";
    const secretKey = "K951B6PE1waDMi640xX08PD3vg6EkVlz";

    const requestId = orderCode;
    const orderIdMomo = orderCode;
    const orderInfo = "Thanh toán đơn hàng " + orderCode;
    const redirectUrl = `${process.env.WEB_URL}/thanks`;
    const ipnUrl = `${process.env.NGROK_API}/api/momo/ipn`;
    const requestType = "payWithATM";
    const extraData = orderId; // lưu orderId DB

    const rawSignature =
      `accessKey=${accessKey}` +
      `&amount=${finalAmount}` +
      `&extraData=${extraData}` +
      `&ipnUrl=${ipnUrl}` +
      `&orderId=${orderIdMomo}` +
      `&orderInfo=${orderInfo}` +
      `&partnerCode=${partnerCode}` +
      `&redirectUrl=${redirectUrl}` +
      `&requestId=${requestId}` +
      `&requestType=${requestType}`;

    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(rawSignature)
      .digest("hex");

    const momoRes = await axios.post(
      "https://test-payment.momo.vn/v2/gateway/api/create",
      {
        partnerCode,
        accessKey,
        requestId,
        amount: finalAmount.toString(),
        orderId: orderIdMomo,
        orderInfo,
        redirectUrl,
        ipnUrl,
        extraData,
        requestType,
        signature,
        lang: "vi"
      }
    );

    res.json({
      payUrl: momoRes.data.payUrl
    });

  } catch (err) {
    await conn.rollback();

  console.error("❌ MOMO ERROR:");
  console.error("Message:", err.message);
  console.error("Stack:", err.stack);
  console.error("Axios response:", err.response?.data);

  res.status(400).json({ 
    message: err.message,
    momo: err.response?.data || null
  });
  } finally {
    conn.release();
  }
});
router.post("/momo/ipn", async (req, res) => {
  const { resultCode, extraData } = req.body;

  try {
    if (Number(resultCode) === 0) {
      const orderId = extraData;

      await db.query(
        "UPDATE orders SET status='paid' WHERE id=?",
        [orderId]
      );

      console.log("✅ Thanh toán thành công order:", orderId);
    }

    res.status(200).json({ message: "OK" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "IPN error" });
  }
});
module.exports = router;