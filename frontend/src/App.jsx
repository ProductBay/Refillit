import { Navigate, Route, Routes } from "react-router-dom";

import Layout from "./components/Layout.jsx";
import Home from "./pages/Home.jsx";
import AuthPage from "./pages/AuthPage.jsx";
import DoctorPortal from "./pages/DoctorPortal.jsx";
import PatientApp from "./pages/PatientApp.jsx";
import PharmacyQueue from "./pages/PharmacyQueue.jsx";
import ReceptionistPortal from "./pages/ReceptionistPortal.jsx";
import DispatchConsole from "./pages/DispatchConsole.jsx";
import CourierConsole from "./pages/CourierConsole.jsx";
import NhfClaims from "./pages/NhfClaims.jsx";
import MohReports from "./pages/MohReports.jsx";
import AdminAccess from "./pages/AdminAccess.jsx";
import DemoNdaGate from "./pages/DemoNdaGate.jsx";
import RoleGate from "./components/RoleGate.jsx";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="auth" element={<AuthPage />} />
        <Route
          path="demo-nda"
          element={
            <RoleGate requireNda={false}>
              <DemoNdaGate />
            </RoleGate>
          }
        />
        <Route
          path="doctor"
          element={
            <RoleGate allow={["doctor"]}>
              <Navigate to="/doctor/dashboard" replace />
            </RoleGate>
          }
        />
        <Route
          path="doctor/:module"
          element={
            <RoleGate allow={["doctor"]}>
              <DoctorPortal />
            </RoleGate>
          }
        />
        <Route
          path="patient"
          element={
            <RoleGate allow={["patient", "caregiver", "patient_proxy"]}>
              <PatientApp />
            </RoleGate>
          }
        />
        <Route
          path="pharmacy"
          element={
            <RoleGate allow={["pharmacy"]}>
              <PharmacyQueue />
            </RoleGate>
          }
        />
        <Route
          path="receptionist"
          element={
            <RoleGate allow={["receptionist"]}>
              <ReceptionistPortal />
            </RoleGate>
          }
        />
        <Route
          path="dispatch"
          element={
            <RoleGate allow={["pharmacy", "admin"]}>
              <DispatchConsole />
            </RoleGate>
          }
        />
        <Route path="dispatch/*" element={<Navigate to="/dispatch" replace />} />
        <Route
          path="courier"
          element={
            <RoleGate allow={["courier"]}>
              <CourierConsole />
            </RoleGate>
          }
        />
        <Route path="courier/*" element={<Navigate to="/courier" replace />} />
        <Route
          path="nhf"
          element={
            <RoleGate allow={["patient", "nhf"]}>
              <NhfClaims />
            </RoleGate>
          }
        />
        <Route
          path="moh"
          element={
            <RoleGate allow={["moh", "admin"]}>
              <MohReports />
            </RoleGate>
          }
        />
        <Route
          path="admin"
          element={
            <RoleGate allow={["admin"]}>
              <AdminAccess />
            </RoleGate>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
