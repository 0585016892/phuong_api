const express = require("express");
const router = express.Router();
const db = require("../db");
const upload = require("../middlewares/upload");
const fs = require("fs");
const path = require("path");
const { log } = require("console");

/* =========================
   GET LIST BOOKS
========================= */
router.get("/", async (req, res) => {
  try {
    let {
      page = 1,
      limit = 10,
      keyword = "",
      category_id,
      min_price,
      max_price,
      sort = "newest",
    } = req.query;

    page = Number(page);
    limit = Number(limit);
    const offset = (page - 1) * limit;

    let where = " WHERE 1 = 1 ";
    const params = [];

    if (keyword) {
      where += " AND books.title LIKE ? ";
      params.push(`%${keyword}%`);
    }

    if (category_id) {
      where += " AND books.category_id = ? ";
      params.push(category_id);
    }

    if (min_price) {
      where += " AND books.price >= ? ";
      params.push(min_price);
    }

    if (max_price) {
      where += " AND books.price <= ? ";
      params.push(max_price);
    }

    let orderBy = " ORDER BY books.created_at DESC ";
    if (sort === "price_asc") orderBy = " ORDER BY books.price ASC ";
    if (sort === "price_desc") orderBy = " ORDER BY books.price DESC ";

    const sqlData = `
      SELECT books.*, categories.name AS category_name
      FROM books
      LEFT JOIN categories ON books.category_id = categories.id
      ${where}
      ${orderBy}
      LIMIT ? OFFSET ?
    `;

    const sqlCount = `
      SELECT COUNT(*) AS total
      FROM books
      ${where}
    `;

    const [[{ total }]] = await db.query(sqlCount, params);
    const [books] = await db.query(sqlData, [...params, limit, offset]);

    if (books.length === 0) {
      return res.json({
        page,
        limit,
        total: 0,
        totalPages: 0,
        data: [],
      });
    }

    const bookIds = books.map((b) => b.id);

    const imageSql = `
      SELECT id, book_id, image_url
      FROM book_images
      WHERE book_id IN (?)
    `;

    const [images] = await db.query(imageSql, [bookIds]);

    const imageMap = {};
    images.forEach((img) => {
      if (!imageMap[img.book_id]) imageMap[img.book_id] = [];
      imageMap[img.book_id].push({
        id: img.id,
        image_url: img.image_url,
      });
    });

    const data = books.map((b) => ({
      ...b,
      images: imageMap[b.id] || [],
    }));

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

/* =========================
   GET BOOK DETAIL
========================= */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const bookSql = `
      SELECT books.*, categories.name AS category_name
      FROM books
      LEFT JOIN categories ON books.category_id = categories.id
      WHERE books.id = ? AND books.status = 1
    `;

    const [books] = await db.query(bookSql, [id]);
    if (books.length === 0)
      return res.status(404).json({ message: "Không tìm thấy sách" });

    const imageSql = `
      SELECT id, image_url
      FROM book_images
      WHERE book_id = ?
    `;

    const [images] = await db.query(imageSql, [id]);

    res.json({
      ...books[0],
      images,
    });
  } catch (err) {
    res.status(500).json(err);
  }
});

/* =========================
   CREATE BOOK
========================= */
router.post("/", upload.array("images", 10), async (req, res) => {
  try {
    const {
      category_id,
      title,
      author,
      publisher,
      price,
      sale_price,
      stock,
      description,
    } = req.body;

    const bookSql = `
      INSERT INTO books
      (category_id, title, author, publisher, price, sale_price, stock, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [result] = await db.query(bookSql, [
      category_id,
      title,
      author,
      publisher,
      price,
      sale_price,
      stock,
      description,
    ]);

    const bookId = result.insertId;

    if (req.files?.length > 0) {
      const imageValues = req.files.map((file) => [
        bookId,
        `/uploads/${file.filename}`,
      ]);

      await db.query(
        "INSERT INTO book_images (book_id, image_url) VALUES ?",
        [imageValues]
      );
    }

    res.json({
      message: "✅ Thêm sách thành công",
      book_id: bookId,
    });
  } catch (err) {
    res.status(500).json(err);
  }
});

/* =========================
   UPDATE BOOK
========================= */
router.put("/:id", upload.array("images", 10), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      category_id,
      title,
      author,
      publisher,
      price,
      sale_price,
      stock,
      description,
      status,
      remove_images,
    } = req.body;

    const updateSql = `
      UPDATE books SET
        category_id=?,
        title=?,
        author=?,
        publisher=?,
        price=?,
        sale_price=?,
        stock=?,
        description=?,
        status=?
      WHERE id=?
    `;

    const [result] = await db.query(updateSql, [
      category_id,
      title,
      author,
      publisher,
      price,
      sale_price,
      stock,
      description,
      status,
      id,
    ]);

    if (result.affectedRows === 0)
      return res.status(404).json({ message: "Không tìm thấy sách" });

    if (remove_images === "true") {
      await db.query("DELETE FROM book_images WHERE book_id = ?", [id]);
    }

    if (req.files?.length > 0) {
      const imageValues = req.files.map((file) => [
        id,
        `/uploads/${file.filename}`,
      ]);

      await db.query(
        "INSERT INTO book_images (book_id, image_url) VALUES ?",
        [imageValues]
      );
    }

    res.json({ message: "✅ Cập nhật sách thành công" });
  } catch (err) {
    res.status(500).json(err);
  }
});

/* =========================
   DELETE BOOK (SOFT)
========================= */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // 1️⃣ Lấy danh sách ảnh của sách
    const [images] = await db.query(
      "SELECT image_url FROM book_images WHERE book_id = ?",
      [id]
    );

    // 2️⃣ Xoá file ảnh khỏi server
    images.forEach((img) => {
      const filePath = path.join(__dirname, "..", img.image_url);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });

    // 3️⃣ Xoá ảnh trong DB
    await db.query("DELETE FROM book_images WHERE book_id = ?", [id]);

    // 4️⃣ Xoá sách trong DB (XOÁ LUÔN)
    const [result] = await db.query(
      "DELETE FROM books WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy sách" });
    }

    res.json({ message: "🗑️ Đã xoá sách vĩnh viễn" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.put("/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
console.log(req.body);
console.log(id);


  if (status === undefined) {
    return res.status(400).json({ message: "Thiếu status" });
  }

  await db.query(
    "UPDATE books SET status = ? WHERE id = ?",
    [status, id]
  );

  res.json({ message: "Cập nhật trạng thái thành công" });
});



module.exports = router;
