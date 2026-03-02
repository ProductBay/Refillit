const express = require("express");
const { requireAuth, requireRoles } = require("../middleware/auth");

const router = express.Router();

router.get("/health", requireAuth, requireRoles(["pharmacy", "admin"]), (req, res) => {
  res.json({ status: "ok" });
});

module.exports = router;
