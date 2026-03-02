const { createHash } = require("node:crypto");

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const hashIdentifier = (value) =>
  createHash("sha256").update(String(value || "")).digest("hex");

module.exports = {
  normalizeEmail,
  hashIdentifier,
};
