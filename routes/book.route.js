const express = require("express");
const router = express.Router();
const db = require("../db");
const upload = require("../middlewares/upload");
const fs = require("fs");
const path = require("path");

/* =========================
   GET LIST BOOKS (Bao gồm danh sách ảnh)
========================= */
router.get("/", async (req, res) => {
  try {
    let {
      page = 1,
      limit = 20,
      keyword = "",
      category_id,
      sort = "newest",
    } = req.query;

    page = Number(page);
    limit = Number(limit);
    const offset = (page - 1) * limit;

    let where = "WHERE 1 = 1";
    const params = [];

    if (keyword) {
      where += " AND books.title LIKE ?";
      params.push(`%${keyword}%`);
    }

    if (category_id) {
      where += " AND books.category_id = ?";
      params.push(category_id);
    }

    let orderBy = "ORDER BY books.created_at DESC";
    if (sort === "price_asc") {
      orderBy = "ORDER BY books.price ASC";
    } else if (sort === "price_desc") {
      orderBy = "ORDER BY books.price DESC";
    }

    // Lấy thông tin sách + Thể loại + Tác giả + Mảng đường dẫn ảnh
    const sql = `
        SELECT
            books.*,
            categories.name AS category_name,
            GROUP_CONCAT(
                DISTINCT authors.full_name
                SEPARATOR ', '
            ) AS authors,
            GROUP_CONCAT(
                DISTINCT book_images.image_url
                SEPARATOR '|||'
            ) AS image_urls
        FROM books

        LEFT JOIN categories ON categories.id = books.category_id
        LEFT JOIN book_authors ON books.id = book_authors.book_id
        LEFT JOIN authors ON authors.id = book_authors.author_id
        LEFT JOIN book_images ON books.id = book_images.book_id

        ${where}

        GROUP BY books.id
        ${orderBy}
        LIMIT ? OFFSET ?
    `;

    const [books] = await db.query(sql, [...params, limit, offset]);

    // Format lại chuỗi image_urls thành Mảng đối tượng images [{ image_url: '...' }]
    const formattedBooks = books.map((book) => {
      const rawUrls = book.image_urls ? book.image_urls.split("|||") : [];
      delete book.image_urls; // Xóa trường tạm
      return {
        ...book,
        images: rawUrls.map((url) => ({ image_url: url })),
      };
    });

    res.json(formattedBooks);
  } catch (error) {
    console.error("❌ GET BOOKS ERROR:", error);
    res.status(500).json(error);
  }
});

/* =========================
   GET BOOK DETAIL (Đầy đủ ảnh & tác giả)
========================= */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [books] = await db.query(
      `
      SELECT
          books.*,
          categories.name AS category_name,
          GROUP_CONCAT(
              DISTINCT authors.full_name
              SEPARATOR ', '
          ) AS authors
      FROM books

      LEFT JOIN categories ON books.category_id = categories.id
      LEFT JOIN book_authors ON books.id = book_authors.book_id
      LEFT JOIN authors ON authors.id = book_authors.author_id

      WHERE books.id = ?
      GROUP BY books.id
    `,
      [id],
    );

    if (!books.length) {
      return res.status(404).json({
        message: "Không tìm thấy truyện",
      });
    }

    // Truy vấn mảng ảnh đầy đủ cho chi tiết sách
    const [images] = await db.query(
      `SELECT id, book_id, image_url FROM book_images WHERE book_id = ?`,
      [id],
    );

    books[0].images = images;

    res.json(books[0]);
  } catch (error) {
    console.error("❌ GET DETAIL ERROR:", error);
    res.status(500).json(error);
  }
});

/* =========================
   CREATE BOOK
========================= */
router.post("/", upload.array("images", 20), async (req, res) => {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const {
      title,
      category_id,
      publisher,
      price,
      sale_price,
      stock,
      description,
    } = req.body;

    let author_ids = req.body.author_ids || [];
    if (typeof author_ids === "string") {
      try {
        author_ids = JSON.parse(author_ids);
      } catch (e) {
        author_ids = [author_ids];
      }
    }

    const [book] = await connection.query(
      `
      INSERT INTO books (
          title,
          category_id,
          publisher,
          price,
          sale_price,
          stock,
          description
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        title,
        Number(category_id) || null,
        publisher || null,
        Number(price) || 0,
        sale_price ? Number(sale_price) : null,
        Number(stock) || 0,
        description || "",
      ],
    );

    const bookId = book.insertId;

    // Lưu liên kết Tác giả
    if (Array.isArray(author_ids) && author_ids.length > 0) {
      const values = author_ids.map((authorId) => [bookId, authorId, "writer"]);
      await connection.query(
        `INSERT INTO book_authors (book_id, author_id, role) VALUES ?`,
        [values],
      );
    }

    // Lưu ảnh vào bảng `book_images`
    if (req.files?.length) {
      const imageValues = req.files.map((file) => [
        bookId,
        `/uploads/${file.filename}`,
      ]);

      await connection.query(
        `INSERT INTO book_images (book_id, image_url) VALUES ?`,
        [imageValues],
      );
    }

    await connection.commit();

    res.json({
      success: true,
      bookId,
      message: "Thêm mới bộ truyện thành công",
    });
  } catch (error) {
    await connection.rollback();
    console.error("❌ CREATE BOOK ERROR:", error);
    res.status(500).json(error);
  } finally {
    connection.release();
  }
});

/* =========================
   UPDATE BOOK (Chuẩn hóa & An toàn dữ liệu)
========================= */
router.put("/:id", upload.array("images", 10), async (req, res) => {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const { id } = req.params;
    let {
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
      author_ids,
    } = req.body;

    // 1. Kiểm tra sự tồn tại của bộ truyện
    const [existingBooks] = await connection.query(
      "SELECT id FROM books WHERE id = ?",
      [id],
    );

    if (existingBooks.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Không tìm thấy sách" });
    }

    // 2. Format author string tránh lỗi SQL Syntax
    let formattedAuthor = "";
    if (Array.isArray(author)) {
      formattedAuthor = author.filter(Boolean).join(", ");
    } else if (typeof author === "string") {
      formattedAuthor = author.trim();
    }

    // 3. Cập nhật bảng trung gian book_authors nếu gửi author_ids
    if (author_ids) {
      if (typeof author_ids === "string") {
        try {
          author_ids = JSON.parse(author_ids);
        } catch (e) {
          author_ids = [author_ids];
        }
      }

      if (Array.isArray(author_ids) && author_ids.length > 0) {
        await connection.query("DELETE FROM book_authors WHERE book_id = ?", [
          id,
        ]);

        const authorValues = author_ids.map((authorId) => [
          id,
          authorId,
          "writer",
        ]);
        await connection.query(
          "INSERT INTO book_authors (book_id, author_id, role) VALUES ?",
          [authorValues],
        );

        if (!formattedAuthor) {
          const [authorRows] = await connection.query(
            "SELECT full_name FROM authors WHERE id IN (?)",
            [author_ids],
          );
          formattedAuthor = authorRows.map((a) => a.full_name).join(", ");
        }
      }
    }

    // 4. Ép kiểu dữ liệu an toàn
    category_id = Number(category_id) || null;
    price = Number(price) || 0;
    sale_price =
      sale_price !== undefined &&
      sale_price !== "" &&
      sale_price !== "null" &&
      sale_price !== null
        ? Number(sale_price)
        : null;
    stock = Number(stock) || 0;
    status = status !== undefined ? Number(status) : 1;
    publisher = publisher || null;
    description = description || "";
    title = title || "Chưa đặt tên";

    // 5. Cập nhật bảng `books`
    const updateSql = `
      UPDATE books SET
        category_id = ?,
        title = ?,
        author = ?,
        publisher = ?,
        price = ?,
        sale_price = ?,
        stock = ?,
        description = ?,
        status = ?
      WHERE id = ?
    `;

    await connection.query(updateSql, [
      category_id,
      title,
      formattedAuthor,
      publisher,
      price,
      sale_price,
      stock,
      description,
      status,
      id,
    ]);

    // 6. Xử lý ảnh cũ nếu có lệnh xóa
    if (remove_images === "true" || remove_images === true) {
      const [oldImages] = await connection.query(
        "SELECT image_url FROM book_images WHERE book_id = ?",
        [id],
      );

      oldImages.forEach((img) => {
        if (img.image_url) {
          const filePath = path.join(__dirname, "..", img.image_url);
          if (fs.existsSync(filePath)) {
            try {
              fs.unlinkSync(filePath);
            } catch (fsErr) {
              console.error("Lỗi xóa file ảnh cũ:", fsErr);
            }
          }
        }
      });

      await connection.query("DELETE FROM book_images WHERE book_id = ?", [id]);
    }

    // 7. Lưu file ảnh mới upload
    if (req.files && req.files.length > 0) {
      const imageValues = req.files.map((file) => [
        id,
        `/uploads/${file.filename}`,
      ]);

      await connection.query(
        "INSERT INTO book_images (book_id, image_url) VALUES ?",
        [imageValues],
      );
    }

    await connection.commit();

    res.json({
      success: true,
      message: "✅ Cập nhật bộ truyện thành công",
    });
  } catch (err) {
    await connection.rollback();
    console.error("❌ UPDATE BOOK ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Lỗi máy chủ khi cập nhật truyện",
      error: err.message || err,
    });
  } finally {
    connection.release();
  }
});

/* =========================
   DELETE BOOK (Xóa sạch DB & File ảnh vật lý)
========================= */
router.delete("/:id", async (req, res) => {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const { id } = req.params;

    const [images] = await connection.query(
      `SELECT image_url FROM book_images WHERE book_id = ?`,
      [id],
    );

    // Xóa file ảnh vật lý trên ổ đĩa
    images.forEach((img) => {
      if (img.image_url) {
        const filePath = path.join(__dirname, "..", img.image_url);
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (e) {
            console.error("Lỗi xóa file ảnh:", e);
          }
        }
      }
    });

    await connection.query("DELETE FROM book_images WHERE book_id = ?", [id]);
    await connection.query("DELETE FROM book_authors WHERE book_id = ?", [id]);
    await connection.query("DELETE FROM books WHERE id = ?", [id]);

    await connection.commit();

    res.json({
      success: true,
      message: "Xóa bộ truyện thành công",
    });
  } catch (error) {
    await connection.rollback();
    console.error("❌ DELETE BOOK ERROR:", error);
    res.status(500).json(error);
  } finally {
    connection.release();
  }
});

/* =========================
   UPDATE STATUS BOOK
========================= */
router.put("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (status === undefined) {
      return res.status(400).json({ message: "Thiếu trường status" });
    }

    await db.query("UPDATE books SET status = ? WHERE id = ?", [status, id]);

    res.json({ message: "Cập nhật trạng thái thành công" });
  } catch (error) {
    console.error("❌ UPDATE STATUS ERROR:", error);
    res.status(500).json(error);
  }
});

module.exports = router;
