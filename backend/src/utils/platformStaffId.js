const STAFF_PREFIX_BY_ROLE = {
  receptionist: "RCPT",
};

const sanitizeDoctorCode = (doctorId) => {
  const cleaned = String(doctorId || "")
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase();
  if (!cleaned) return "GEN";
  return cleaned.slice(0, 6).padEnd(6, "X");
};

const buildReceptionistId = ({ doctorId, serial }) =>
  `RCPT-${sanitizeDoctorCode(doctorId)}-${String(serial).padStart(5, "0")}`;

const extractSerial = (value, prefix) => {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw.startsWith(`${prefix}-`)) return null;
  const match = raw.match(/-(\d{1,10})$/);
  if (!match) return null;
  const serial = Number(match[1]);
  return Number.isFinite(serial) ? serial : null;
};

const nextPlatformStaffIdForRole = async ({ UserModel, role, doctorId }) => {
  const prefix = STAFF_PREFIX_BY_ROLE[role];
  if (!prefix) return null;
  const users = await UserModel.findAll({ where: { role } });
  let maxSerial = 0;
  for (const user of users) {
    const serial = extractSerial(user.platformStaffId, prefix);
    if (serial && serial > maxSerial) maxSerial = serial;
  }
  if (role === "receptionist") {
    return buildReceptionistId({ doctorId, serial: maxSerial + 1 });
  }
  return `${prefix}-${String(maxSerial + 1).padStart(5, "0")}`;
};

const ensurePlatformStaffId = async ({ UserModel, user, role }) => {
  const targetRole = role || user?.role;
  const prefix = STAFF_PREFIX_BY_ROLE[targetRole];
  if (!prefix || !user) return null;
  if (extractSerial(user.platformStaffId, prefix)) return user.platformStaffId;
  const nextId = await nextPlatformStaffIdForRole({
    UserModel,
    role: targetRole,
    doctorId: user.createdByDoctorId || null,
  });
  user.platformStaffId = nextId;
  await user.save();
  return nextId;
};

module.exports = {
  nextPlatformStaffIdForRole,
  ensurePlatformStaffId,
  sanitizeDoctorCode,
};
