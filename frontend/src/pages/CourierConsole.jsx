import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import DispatchHub from "./DispatchHub.jsx";

export default function CourierConsole() {
  const { role } = useAuth();
  if (role === "pharmacy" || role === "admin") return <Navigate to="/dispatch" replace />;
  return <DispatchHub mode="courier" />;
}
