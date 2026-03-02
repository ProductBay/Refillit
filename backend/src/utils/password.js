const bcrypt = require("bcrypt");

const hashPassword = async (password) => bcrypt.hash(password, 10);

const verifyPassword = async (password, hash) => bcrypt.compare(password, hash);

module.exports = {
  hashPassword,
  verifyPassword,
};
