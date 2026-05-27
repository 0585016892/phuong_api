const express = require("express");
const db = require("../db");

const router = express.Router();

// ================= UTIL =================
const slugify = (str) =>
  str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

// ======================================================
// CREATE CATEGORY
// ======================================================
router.post("/", async (req, res) => {
  try {
    const { name, parent_id = 0, status = 1 } = req.body;

    if (!name) {
      return res.status(400).json({
        message: "Tên danh mục không được để trống",
      });
    }

    const slug = slugify(name);

    // check slug tồn tại
    const [checkSlug] = await db.query(
      "SELECT id FROM categories WHERE slug = ?",
      [slug],
    );

    if (checkSlug.length > 0) {
      return res.status(400).json({
        message: "Danh mục đã tồn tại",
      });
    }

    // check parent tồn tại
    if (parent_id != 0) {
      const [parent] = await db.query(
        "SELECT id FROM categories WHERE id = ?",
        [parent_id],
      );

      if (parent.length === 0) {
        return res.status(400).json({
          message: "Danh mục cha không tồn tại",
        });
      }
    }

    const [result] = await db.query(
      `
      INSERT INTO categories
      (name, slug, parent_id, status, created_at)
      VALUES (?, ?, ?, ?, NOW())
    `,
      [name, slug, parent_id, status],
    );

    res.json({
      success: true,
      message: "✅ Thêm danh mục thành công",
      id: result.insertId,
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
});

// ======================================================
// UPDATE CATEGORY
// ======================================================
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { name, parent_id = 0, status = 1 } = req.body;

    if (!name) {
      return res.status(400).json({
        message: "Tên danh mục không được để trống",
      });
    }

    // không cho chính nó làm cha
    if (Number(id) === Number(parent_id)) {
      return res.status(400).json({
        message: "Danh mục cha không hợp lệ",
      });
    }

    const slug = slugify(name);

    // check slug trùng
    const [checkSlug] = await db.query(
      `
      SELECT id
      FROM categories
      WHERE slug = ?
      AND id != ?
    `,
      [slug, id],
    );

    if (checkSlug.length > 0) {
      return res.status(400).json({
        message: "Slug đã tồn tại",
      });
    }

    // check parent
    if (parent_id != 0) {
      const [parent] = await db.query(
        `
        SELECT id
        FROM categories
        WHERE id = ?
      `,
        [parent_id],
      );

      if (parent.length === 0) {
        return res.status(400).json({
          message: "Danh mục cha không tồn tại",
        });
      }
    }

    const [result] = await db.query(
      `
      UPDATE categories
      SET
        name = ?,
        slug = ?,
        parent_id = ?,
        status = ?,
        updated_at = NOW()
      WHERE id = ?
    `,
      [name, slug, parent_id, status, id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Không tìm thấy danh mục",
      });
    }

    res.json({
      success: true,
      message: "✅ Cập nhật thành công",
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
});

// ======================================================
// DELETE CATEGORY
// ======================================================
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // check danh mục con
    const [children] = await db.query(
      `
      SELECT id
      FROM categories
      WHERE parent_id = ?
    `,
      [id],
    );

    if (children.length > 0) {
      return res.status(400).json({
        message: "Không thể xoá vì còn danh mục con",
      });
    }

    const [result] = await db.query(
      `
      DELETE FROM categories
      WHERE id = ?
    `,
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Không tìm thấy danh mục",
      });
    }

    res.json({
      success: true,
      message: "🗑️ Xoá thành công",
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
});

// ======================================================
// LIST + SEARCH + PAGINATION
// ======================================================
router.get("/", async (req, res) => {
  try {
    let { page = 1, limit = 10, keyword = "", status } = req.query;

    page = Number(page);
    limit = Number(limit);

    const offset = (page - 1) * limit;

    let where = "WHERE 1=1";
    const params = [];

    // search
    if (keyword) {
      where += " AND c.name LIKE ?";
      params.push(`%${keyword}%`);
    }

    // status
    if (status !== undefined && status !== "") {
      where += " AND c.status = ?";
      params.push(status);
    }

    const sqlCount = `
      SELECT COUNT(*) as total
      FROM categories c
      ${where}
    `;

    const sqlData = `
      SELECT
        c.*,
        p.name as parent_name
      FROM categories c
      LEFT JOIN categories p
        ON c.parent_id = p.id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const [[{ total }]] = await db.query(sqlCount, params);

    const [rows] = await db.query(sqlData, [...params, limit, offset]);

    res.json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      data: rows,
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
});

// ======================================================
// TREE CATEGORY
// ======================================================
router.get("/tree/all", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT *
      FROM categories
      WHERE status = 1
      ORDER BY id ASC
    `);

    const parents = rows.filter((item) => item.parent_id === 0);

    const result = parents.map((parent) => ({
      ...parent,
      children: rows.filter((child) => child.parent_id === parent.id),
    }));

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
});

// ======================================================
// DETAIL
// ======================================================
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query(
      `
      SELECT
        c.*,
        p.name as parent_name
      FROM categories c
      LEFT JOIN categories p
      ON c.parent_id = p.id
      WHERE c.id = ?
    `,
      [id],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        message: "Không tìm thấy danh mục",
      });
    }

    res.json({
      success: true,
      data: rows[0],
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
});

module.exports = router;
