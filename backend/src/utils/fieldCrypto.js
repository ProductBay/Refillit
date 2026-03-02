const crypto = require("node:crypto");

const deriveKey = () => {
  const source =
    process.env.DATA_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    "dev_data_key_change_me";
  return crypto.createHash("sha256").update(source).digest();
};

const encryptValue = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const iv = crypto.randomBytes(12);
  const key = deriveKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = String(value);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
};

const decryptValue = (value) => {
  if (!value) return null;
  if (!String(value).startsWith("enc:v1:")) return String(value);
  const [, , ivB64, tagB64, bodyB64] = String(value).split(":");
  const key = deriveKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const out = Buffer.concat([
    decipher.update(Buffer.from(bodyB64, "base64")),
    decipher.final(),
  ]);
  return out.toString("utf8");
};

module.exports = {
  encryptValue,
  decryptValue,
};
