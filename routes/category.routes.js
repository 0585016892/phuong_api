const express = require("express");
const db = require("../db"); // mysql2/promise pool
const router = express.Router();

// ================= UTIL =================
const slugify = (str) =>
  str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

// ================= CREATE =================
router.post("/", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ message: "Tên danh mục không được rỗng" });
    }

    const slug = slugify(name);

    await db.query(
      "INSERT INTO categories (name, slug, status) VALUES (?, ?, ?)",
      [name, slug,1]
    );

    res.json({ message: "✅ Thêm danh mục thành công" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ================= UPDATE =================
router.put("/:id", async (req, res) => {
  try {
    const { name } = req.body;
    const { status } = req.body;
    const { id } = req.params;

    if (!name) {
      return res.status(400).json({ message: "Tên danh mục không được rỗng" });
    }

    const slug = slugify(name);

    const [result] = await db.query(
      "UPDATE categories SET name = ?, slug = ?,status = ? WHERE id = ?",
      [name, slug,status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy danh mục" });
    }

    res.json({ message: "✅ Cập nhật thành công" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ================= DELETE =================
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await db.query(
      "DELETE FROM categories WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy danh mục" });
    }

    res.json({ message: "🗑️ Đã xoá danh mục" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ================= LIST + SEARCH + PAGINATION =================
router.get("/", async (req, res) => {
  try {
    let { page = 1, limit = 10, keyword = "" } = req.query;

    page = Number(page);
    limit = Number(limit);
    const offset = (page - 1) * limit;

    let where = "";
    const params = [];

    if (keyword) {
      where = "WHERE name LIKE ?";
      params.push(`%${keyword}%`);
    }

    const sqlData = `
      SELECT *
      FROM categories
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    const sqlCount = `
      SELECT COUNT(*) AS total
      FROM categories
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

// ================= DETAIL =================
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query(
      "SELECT * FROM categories WHERE id = ?",
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Không tìm thấy danh mục" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
