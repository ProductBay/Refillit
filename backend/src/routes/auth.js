const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  User,
  DoctorProfile,
  PatientProfile,
  PharmacyProfile,
  NhfProfile,
  CourierProfile,
} = require("../models");
const { normalizeEmail } = require("../utils/crypto");
const { hashPassword, verifyPassword } = require("../utils/password");
const { signAccessToken } = require("../utils/jwt");
const { writeAudit } = require("../utils/audit");
const { nextPlatformStaffIdForRole } = require("../utils/platformStaffId");

const router = express.Router();

router.post("/register", async (req, res, next) => {
  try {
    const { fullName, email, password, role } = req.body || {};
    if (!fullName || !email || !password) {
      return res.status(400).json({ error: "fullName, email, password are required" });
    }
    const normalized = normalizeEmail(email);
    const existing = await User.findOne({ where: { email: normalized } });
    if (existing) {
      return res.status(409).json({ error: "User already exists" });
    }
    const user = await User.create({
      fullName,
      email: normalized,
      role: role || "patient",
      passwordHash: await hashPassword(password),
      platformStaffId:
        (role || "patient") === "receptionist"
          ? await nextPlatformStaffIdForRole({
              UserModel: User,
              role: "receptionist",
              doctorId: null,
            })
          : undefined,
    });

    if (user.role === "doctor") {
      await DoctorProfile.findOrCreate({
        where: { userId: user.id },
        defaults: { userId: user.id, mohVerified: false, clinicInfo: {} },
      });
    } else if (user.role === "patient") {
      await PatientProfile.findOrCreate({
        where: { userId: user.id },
        defaults: { userId: user.id },
      });
    } else if (user.role === "pharmacy") {
      await PharmacyProfile.findOrCreate({
        where: { userId: user.id },
        defaults: { userId: user.id, registeredName: fullName },
      });
    } else if (user.role === "nhf") {
      await NhfProfile.findOrCreate({
        where: { userId: user.id },
        defaults: { userId: user.id },
      });
    } else if (user.role === "courier") {
      await CourierProfile.findOrCreate({
        where: { userId: user.id },
        defaults: { userId: user.id },
      });
    }

    await writeAudit({
      actorUserId: user.id,
      action: "auth.register",
      entityType: "user",
      entityId: user.id,
    });
    const token = signAccessToken({ id: user.id, role: user.role });
    return res.status(201).json({ user, token });
  } catch (error) {
    return next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const normalized = normalizeEmail(email);
    const user = await User.findOne({ where: { email: normalized } });
    if (!user || !(await verifyPassword(password || "", user.passwordHash || ""))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = signAccessToken({ id: user.id, role: user.role });
    return res.json({ user, token });
  } catch (error) {
    return next(error);
  }
});

router.get("/me", requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
