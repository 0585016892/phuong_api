const multer = require("multer");
const path = require("path");
const fs = require("fs");

const uploadDir = path.join(__dirname, "../uploads/authors");

// tạo folder nếu chưa có

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, {
    recursive: true,
  });

  console.log("CREATE UPLOAD DIR:", uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    console.log("UPLOAD DESTINATION:", uploadDir);

    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    console.log("UPLOAD FILE:", file.originalname);

    const ext = path.extname(file.originalname);

    const filename =
      Date.now() + "-" + Math.round(Math.random() * 999999) + ext;

    cb(null, filename);
  },
});

const fileFilter = (req, file, cb) => {
  console.log("CHECK FILE:", file.mimetype);

  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new Error("Không phải file ảnh"), false);
  }
};

module.exports = multer({
  storage,

  fileFilter,

  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});
