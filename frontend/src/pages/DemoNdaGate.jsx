import { useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import GlobalFeedbackOverlay from "../components/GlobalFeedbackOverlay.jsx";

const roleHome = (role) => {
  if (role === "doctor") return "/doctor/dashboard";
  if (["patient", "caregiver", "patient_proxy"].includes(role)) return "/patient";
  if (role === "pharmacy") return "/pharmacy";
  if (role === "receptionist") return "/receptionist";
  if (role === "courier") return "/courier";
  if (role === "nhf") return "/nhf";
  if (role === "moh") return "/moh";
  if (role === "admin") return "/admin";
  return "/";
};

export default function DemoNdaGate() {
  const navigate = useNavigate();
  const {
    isAuthed,
    user,
    ndaLoading,
    ndaRequired,
    ndaAccepted,
    ndaTitle,
    ndaText,
    ndaVersion,
    ndaRequireTypedName,
    ndaAcceptedAt,
    acceptDemoNda,
    refreshDemoNdaStatus,
  } = useAuth();
  const [agreed, setAgreed] = useState(false);
  const [acceptedName, setAcceptedName] = useState(user?.fullName || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const nextRoute = useMemo(() => roleHome(String(user?.role || "").toLowerCase()), [user?.role]);

  if (!isAuthed) return <Navigate to="/auth" replace />;
  if (ndaLoading) {
    return (
      <section className="panel nda-gate">
        <h2>Loading confidentiality agreement...</h2>
      </section>
    );
  }
  if (!ndaRequired || ndaAccepted) {
    return <Navigate to={nextRoute} replace />;
  }

  const accept = async () => {
    try {
      setSaving(true);
      setError("");
      setSuccess("");
      await acceptDemoNda({ acceptedName: acceptedName.trim(), agreed });
      await refreshDemoNdaStatus();
      setSuccess("Agreement accepted.");
      navigate(nextRoute, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel nda-gate">
      <h2>{ndaTitle || "Confidential Demo Agreement"}</h2>
      <p className="meta">Version: {ndaVersion || "n/a"}</p>
      {ndaAcceptedAt ? <p className="meta">Accepted at: {new Date(ndaAcceptedAt).toLocaleString()}</p> : null}
      <div className="nda-gate__text">{ndaText || "No agreement text configured."}</div>
      <div className="nda-gate__controls">
        <label>
          Printed name
          <input
            value={acceptedName}
            onChange={(event) => setAcceptedName(event.target.value)}
            placeholder="Type your full name"
            disabled={saving}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(event) => setAgreed(Boolean(event.target.checked))}
            disabled={saving}
          />
          I agree to the confidentiality and intellectual property terms above.
        </label>
        <button
          className="primary"
          type="button"
          onClick={accept}
          disabled={saving || !agreed || (ndaRequireTypedName && acceptedName.trim().length < 2)}
        >
          {saving ? "Accepting..." : "Accept & Continue"}
        </button>
      </div>
      <GlobalFeedbackOverlay
        successMessage={success}
        errorMessage={error}
        onClose={() => {
          setSuccess("");
          setError("");
        }}
      />
    </section>
  );
}
