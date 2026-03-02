const jwt = require("jsonwebtoken");

const getSecret = () => process.env.JWT_SECRET || "dev_jwt_secret_change_me";

const signAccessToken = (payload) =>
  jwt.sign(payload, getSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || "12h",
  });

const verifyAccessToken = (token) => jwt.verify(token, getSecret());

module.exports = {
  signAccessToken,
  verifyAccessToken,
};
