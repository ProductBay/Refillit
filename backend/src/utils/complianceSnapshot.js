const crypto = require("node:crypto");

const snapshotSealPayload = (snapshot) => ({
  generatedAt: snapshot.generatedAt,
  generatedBy: snapshot.generatedBy,
  filters: snapshot.filters || {},
  summary: snapshot.summary || {},
  events: Array.isArray(snapshot.events) ? snapshot.events : [],
});

const computeSnapshotChecksum = (snapshot) =>
  crypto.createHash("sha256").update(JSON.stringify(snapshotSealPayload(snapshot))).digest("hex");

const buildSignaturePayload = ({ snapshot, signerId, signedAt, prevSignatureHash }) => ({
  snapshotId: snapshot.id,
  checksum: snapshot.checksum || null,
  generatedAt: snapshot.generatedAt || null,
  generatedBy: snapshot.generatedBy || null,
  signerId: signerId || null,
  signedAt: signedAt || null,
  prevSignatureHash: prevSignatureHash || null,
});

const computeSnapshotSignatureHash = ({ snapshot, signerId, signedAt, prevSignatureHash, signingKey }) =>
  crypto
    .createHmac("sha256", String(signingKey || "dev-compliance-signing-key"))
    .update(JSON.stringify(buildSignaturePayload({ snapshot, signerId, signedAt, prevSignatureHash })))
    .digest("hex");

const createSnapshotSignature = ({ snapshot, signerId, prevSignatureHash, signingKey }) => {
  const signedAt = new Date().toISOString();
  const signatureHash = computeSnapshotSignatureHash({
    snapshot,
    signerId,
    signedAt,
    prevSignatureHash,
    signingKey,
  });
  return {
    algorithm: "HMAC-SHA256",
    signerId: signerId || null,
    signedAt,
    prevSignatureHash: prevSignatureHash || null,
    signatureHash,
  };
};

const verifySnapshotRecord = ({ snapshot, previousSnapshot, signingKey }) => {
  const computedChecksum = computeSnapshotChecksum(snapshot);
  const integrityOk = String(snapshot.checksum || "") === String(computedChecksum || "");
  const signature = snapshot.signature || null;
  const signatureFieldsOk = Boolean(
    signature &&
      String(signature.algorithm || "").toUpperCase() === "HMAC-SHA256" &&
      signature.signerId &&
      signature.signedAt &&
      signature.signatureHash
  );
  let expectedSignatureHash = null;
  let signatureOk = false;
  if (signatureFieldsOk) {
    expectedSignatureHash = computeSnapshotSignatureHash({
      snapshot,
      signerId: signature.signerId,
      signedAt: signature.signedAt,
      prevSignatureHash: signature.prevSignatureHash || null,
      signingKey,
    });
    signatureOk = String(signature.signatureHash || "") === String(expectedSignatureHash || "");
  }
  const previousHash = previousSnapshot?.signature?.signatureHash || null;
  const chainOk = String(signature?.prevSignatureHash || "") === String(previousHash || "");
  const overallValid = integrityOk && signatureOk && chainOk;
  return {
    integrityOk,
    signatureOk,
    chainOk,
    overallValid,
    computedChecksum,
    expectedSignatureHash,
    previousSignatureHash: previousHash,
  };
};

module.exports = {
  snapshotSealPayload,
  computeSnapshotChecksum,
  createSnapshotSignature,
  verifySnapshotRecord,
};
