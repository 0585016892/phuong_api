require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// static ảnh upload
app.use("/uploads", express.static("uploads"));

app.use("/api/books", require("./routes/book.route"));
app.use("/api/users", require("./routes/user.routes"));
app.use("/api/categories", require("./routes/category.routes"));
app.use("/api/coupons", require("./routes/coupon.routes"));
app.use("/api/dashboard", require("./routes/dashboard.routes"));
app.use("/api/orders", require("./routes/order.routes"));
app.use("/api/payment", require("./routes/momo.route"));

const PORT = 2002;
app.listen(PORT, () => {
  console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
});
