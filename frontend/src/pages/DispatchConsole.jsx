import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import DispatchHub from "./DispatchHub.jsx";

export default function DispatchConsole() {
  const { role } = useAuth();
  if (role === "courier") return <Navigate to="/courier" replace />;
  return <DispatchHub mode="dispatch" />;
}
