import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function RoleGate({ allow, requireNda = true, children }) {
  const { isAuthed, role, ndaLoading, ndaRequired, ndaAccepted } = useAuth();
  if (!isAuthed) {
    return <Navigate to="/auth" replace />;
  }
  if (requireNda && ndaLoading) {
    return (
      <section className="panel">
        <h2>Loading agreement</h2>
        <p>Checking demo confidentiality acceptance status...</p>
      </section>
    );
  }
  if (requireNda && ndaRequired && !ndaAccepted) {
    return <Navigate to="/demo-nda" replace />;
  }
  if (Array.isArray(allow) && allow.length && !allow.includes(role)) {
    return (
      <section className="panel">
        <h2>Access denied</h2>
        <p>This page requires one of: {allow.join(", ")}.</p>
      </section>
    );
  }
  return children;
}
