const { User } = require("../models");
const { verifyAccessToken } = require("../utils/jwt");

const requireAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: "Missing token" });
    }
    const payload = verifyAccessToken(token);
    req.user = { id: payload.id, role: payload.role };
    if (process.env.AUTH_LOOKUP_DB !== "false") {
      const user = await User.findByPk(payload.id);
      if (user) {
        req.user.fullName = user.fullName;
        req.user.email = user.email;
        req.user.platformStaffId = user.platformStaffId || null;
        req.user.createdByDoctorId = user.createdByDoctorId || null;
        req.user.nhfRole = user.nhfRole || null;
        req.user.nhfLocked = Boolean(user.nhfLocked);
        req.user.mohRole = user.mohRole || null;
        req.user.mohLocked = Boolean(user.mohLocked);
      }
    }
    if (req.user?.role === "nhf" && req.user.nhfLocked) {
      return res.status(403).json({ error: "NHF account locked" });
    }
    if (req.user?.role === "moh" && req.user.mohLocked) {
      return res.status(403).json({ error: "MOH account locked" });
    }
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

const requireRoles = (roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return next();
};

module.exports = {
  requireAuth,
  requireRoles,
};
