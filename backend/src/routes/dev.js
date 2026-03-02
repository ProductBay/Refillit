const express = require("express");
const { truncateTables } = require("../db/memoryStore");

const router = express.Router();

router.post("/reset", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Forbidden" });
  }
  truncateTables();
  return res.json({ ok: true });
});

module.exports = router;
