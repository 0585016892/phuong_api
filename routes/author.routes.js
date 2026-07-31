const express = require("express");
const router = express.Router();

const db = require("../db");
const upload = require("../middlewares/uploadAuthor");

const fs = require("fs");
const path = require("path");

// ================================
// XÓA FILE ẢNH
// ================================
const deleteFile = (filePath) => {
  try {
    if (!filePath) return;

    const fullPath = path.join(__dirname, "..", filePath);

    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      console.log("Deleted:", fullPath);
    }
  } catch (err) {
    console.log("DELETE FILE ERROR:", err.message);
  }
};

// ================================
// GET ALL AUTHORS
// ================================
router.get("/", async (req, res) => {
  try {
    const [rows] = await db.query(`

SELECT 
    authors.*,
    COUNT(book_authors.book_id) AS total_books

FROM authors

LEFT JOIN book_authors
ON authors.id = book_authors.author_id

GROUP BY authors.id

ORDER BY authors.created_at DESC

`);

    res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("GET AUTHORS ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Lỗi lấy danh sách tác giả",
    });
  }
});

// ================================
// GET AUTHOR DETAIL
// ================================
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query(
      `

SELECT *

FROM authors

WHERE id=?

`,
      [id],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy tác giả",
      });
    }

    const [books] = await db.query(
      `

SELECT

books.id,
books.title,
books.price

FROM books

JOIN book_authors

ON books.id = book_authors.book_id

WHERE book_authors.author_id = ?

`,
      [id],
    );

    res.json({
      success: true,

      data: {
        ...rows[0],
        books,
      },
    });
  } catch (error) {
    console.error("GET AUTHOR DETAIL ERROR:", error);

    res.status(500).json(error);
  }
});

// ================================
// CREATE AUTHOR
// ================================
router.post(
  "/",

  upload.fields([
    {
      name: "avatar",
      maxCount: 1,
    },

    {
      name: "cover_image",
      maxCount: 1,
    },
  ]),

  async (req, res) => {
    const connection = await db.getConnection();

    console.log("BODY:");
    console.log(req.body);

    console.log("FILES:");
    console.log(req.files);
    try {
      await connection.beginTransaction();

      const {
        full_name,
        pen_name,
        slug,
        nationality,
        birth_date,
        death_date,
        role,
        biography,
        facebook_url,
        website_url,
        status,
      } = req.body;

      if (!full_name) {
        return res.status(400).json({
          message: "Thiếu tên tác giả",
        });
      }

      let avatar = null;
      let cover_image = null;

      if (req.files?.avatar) {
        avatar = "/uploads/authors/" + req.files.avatar[0].filename;
      }

      if (req.files?.cover_image) {
        cover_image = "/uploads/authors/" + req.files.cover_image[0].filename;
      }

      const [result] = await connection.query(
        `


INSERT INTO authors

(
full_name,
pen_name,
slug,
avatar,
cover_image,
nationality,
birth_date,
death_date,
role,
biography,
facebook_url,
website_url,
status

)

VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)


`,
        [
          full_name,
          pen_name,
          slug,
          avatar,
          cover_image,
          nationality,
          birth_date || null,
          death_date || null,
          role || "author",
          biography,
          facebook_url,
          website_url,
          status || "active",
        ],
      );

      await connection.commit();

      res.json({
        success: true,
        message: "Thêm tác giả thành công",
        id: result.insertId,
      });
    } catch (error) {
      await connection.rollback();

      console.error("CREATE AUTHOR ERROR:", error);

      res.status(500).json({
        success: false,
        error: error.message,
      });
    } finally {
      connection.release();
    }
  },
);

// ================================
// UPDATE AUTHOR
// ================================
router.put(
  "/:id",

  upload.fields([
    {
      name: "avatar",
      maxCount: 1,
    },

    {
      name: "cover_image",
      maxCount: 1,
    },
  ]),

  async (req, res) => {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const id = req.params.id;

      const [old] = await connection.query(
        `

SELECT avatar,cover_image

FROM authors

WHERE id=?

`,
        [id],
      );

      if (!old.length) {
        return res.status(404).json({
          message: "Không tồn tại tác giả",
        });
      }

      let avatar = old[0].avatar;

      let cover_image = old[0].cover_image;

      if (req.files?.avatar) {
        deleteFile(avatar);

        avatar = "/uploads/authors/" + req.files.avatar[0].filename;
      }

      if (req.files?.cover_image) {
        deleteFile(cover_image);

        cover_image = "/uploads/authors/" + req.files.cover_image[0].filename;
      }

      const {
        full_name,
        pen_name,
        slug,
        nationality,
        birth_date,
        death_date,
        role,
        biography,
        facebook_url,
        website_url,
        status,
      } = req.body;

      await connection.query(
        `


UPDATE authors

SET

full_name=?,
pen_name=?,
slug=?,
avatar=?,
cover_image=?,
nationality=?,
birth_date=?,
death_date=?,
role=?,
biography=?,
facebook_url=?,
website_url=?,
status=?


WHERE id=?


`,
        [
          full_name,
          pen_name,
          slug,
          avatar,
          cover_image,
          nationality,
          birth_date || null,
          death_date || null,
          role,
          biography,
          facebook_url,
          website_url,
          status,
          id,
        ],
      );

      await connection.commit();

      res.json({
        success: true,
        message: "Cập nhật tác giả thành công",
      });
    } catch (error) {
      await connection.rollback();

      console.error("UPDATE AUTHOR ERROR:", error);

      res.status(500).json(error);
    } finally {
      connection.release();
    }
  },
);

// ================================
// DELETE AUTHOR
// ================================
router.delete("/:id", async (req, res) => {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const id = req.params.id;

    // check book_authors

    const [books] = await connection.query(
      `

SELECT book_id

FROM book_authors

WHERE author_id=?

`,
      [id],
    );

    if (books.length) {
      return res.status(400).json({
        success: false,

        message: "Tác giả đang có truyện, không thể xóa",
      });
    }

    const [author] = await connection.query(
      `

SELECT avatar,cover_image

FROM authors

WHERE id=?

`,
      [id],
    );

    if (author.length) {
      deleteFile(author[0].avatar);

      deleteFile(author[0].cover_image);
    }

    await connection.query(
      `
DELETE FROM authors
WHERE id=?
`,

      [id],
    );

    await connection.commit();

    res.json({
      success: true,
      message: "Xóa tác giả thành công",
    });
  } catch (error) {
    await connection.rollback();

    console.error("DELETE AUTHOR ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  } finally {
    connection.release();
  }
});

module.exports = router;
