import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { apiFetch } from "../utils/api.js";

export default function AuthPage() {
  const { apiBase, setAuth } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    password: "",
    role: "patient",
  });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [showOnboardingModal, setShowOnboardingModal] = useState(false);
  const [onboardingForm, setOnboardingForm] = useState({
    role: "doctor",
    fullName: "",
    email: "",
    phone: "",
    doctorLicenseNumber: "",
    doctorIssuingBody: "",
    doctorClinicName: "",
    doctorPracticeAddress: "",
    doctorRegistryUrl: "",
    pharmacyRegisteredName: "",
    pharmacyCouncilReg: "",
    pharmacyPharmacistInCharge: "",
    pharmacyAddress: "",
    pharmacyRegistryUrl: "",
    courierVehicleType: "",
    courierServiceZone: "",
    courierGovernmentId: "",
    courierAddress: "",
  });

  const onSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setStatus("Submitting...");
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body =
        mode === "login"
          ? { email: form.email, password: form.password }
          : form;
      const data = await apiFetch({ apiBase, path, method: "POST", body });
      setAuth({ token: data.token, user: data.user });
      setStatus(`Signed in as ${data.user.role}`);
      const role = String(data?.user?.role || "").toLowerCase();
      if (role === "courier") {
        navigate("/courier", { replace: true });
        return;
      }
      if (role === "pharmacy" || role === "admin") {
        navigate("/dispatch", { replace: true });
        return;
      }
      if (role === "doctor") {
        navigate("/doctor/dashboard", { replace: true });
        return;
      }
      if (role === "receptionist") {
        navigate("/receptionist", { replace: true });
        return;
      }
      if (role === "patient" || role === "caregiver" || role === "patient_proxy") {
        navigate("/patient", { replace: true });
        return;
      }
      if (role === "moh") {
        navigate("/moh", { replace: true });
        return;
      }
      navigate("/", { replace: true });
    } catch (err) {
      setStatus("");
      setError(err.message);
    }
  };

  const submitOnboardingRequest = async () => {
    setError("");
    setStatus("Submitting onboarding request...");
    try {
      const role = String(onboardingForm.role || "").toLowerCase();
      const payload = {
        role,
        fullName: onboardingForm.fullName,
        email: onboardingForm.email,
        phone: onboardingForm.phone,
        credentials: {},
      };
      if (role === "doctor") {
        payload.credentials = {
          licenseNumber: onboardingForm.doctorLicenseNumber,
          issuingBody: onboardingForm.doctorIssuingBody,
          clinicName: onboardingForm.doctorClinicName,
          practiceAddress: onboardingForm.doctorPracticeAddress,
          registryUrl: onboardingForm.doctorRegistryUrl,
        };
      } else if (role === "pharmacy") {
        payload.credentials = {
          registeredName: onboardingForm.pharmacyRegisteredName,
          councilReg: onboardingForm.pharmacyCouncilReg,
          pharmacistInCharge: onboardingForm.pharmacyPharmacistInCharge,
          address: onboardingForm.pharmacyAddress,
          registryUrl: onboardingForm.pharmacyRegistryUrl,
        };
      } else if (role === "courier") {
        payload.credentials = {
          vehicleType: onboardingForm.courierVehicleType,
          serviceZone: onboardingForm.courierServiceZone,
          governmentId: onboardingForm.courierGovernmentId,
          address: onboardingForm.courierAddress,
        };
      }

      await apiFetch({
        apiBase,
        path: "/api/onboarding-requests",
        method: "POST",
        body: payload,
      });
      setStatus("Onboarding request submitted. Admin team will review and contact you.");
      setShowOnboardingModal(false);
      setOnboardingForm((current) => ({
        ...current,
        fullName: "",
        email: "",
        phone: "",
      }));
    } catch (err) {
      setStatus("");
      setError(err.message);
    }
  };

  return (
    <section className="panel">
      <h2>Authentication</h2>
      <div className="tabs">
        <button className={`tab ${mode === "login" ? "active" : ""}`} onClick={() => setMode("login")}>
          Login
        </button>
        <button
          className={`tab ${mode === "register" ? "active" : ""}`}
          onClick={() => setMode("register")}
        >
          Register
        </button>
      </div>
      <form className="form" onSubmit={onSubmit}>
        {mode === "register" ? (
          <>
            <label>
              Full name
              <input
                value={form.fullName}
                onChange={(e) => setForm((s) => ({ ...s, fullName: e.target.value }))}
              />
            </label>
            <label>
              Role
              <select
                value={form.role}
                onChange={(e) => setForm((s) => ({ ...s, role: e.target.value }))}
              >
                {["patient", "doctor", "pharmacy", "courier", "moh", "receptionist", "admin"].map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        <label>
          Email
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm((s) => ({ ...s, password: e.target.value }))}
          />
        </label>
        <button className="primary" type="submit">
          {mode === "login" ? "Login" : "Create account"}
        </button>
      </form>
      <div className="form-row">
        <button className="ghost" type="button" onClick={() => setShowOnboardingModal(true)}>
          Request onboarding (doctor/pharmacy/courier)
        </button>
      </div>
      {status ? <p className="meta">{status}</p> : null}
      {error ? <p className="notice error">{error}</p> : null}
      {showOnboardingModal ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="onboardingModalTitle">
            <div className="modal-header">
              <h3 id="onboardingModalTitle">Request Onboarding</h3>
              <button className="ghost" type="button" onClick={() => setShowOnboardingModal(false)}>
                Close
              </button>
            </div>
            <div className="modal-body form">
              <label>
                Role
                <select
                  value={onboardingForm.role}
                  onChange={(e) => setOnboardingForm((current) => ({ ...current, role: e.target.value }))}
                >
                  <option value="doctor">doctor</option>
                  <option value="pharmacy">pharmacy</option>
                  <option value="courier">courier</option>
                </select>
              </label>
              <label>
                Full name
                <input
                  value={onboardingForm.fullName}
                  onChange={(e) => setOnboardingForm((current) => ({ ...current, fullName: e.target.value }))}
                />
              </label>
              <label>
                Email
                <input
                  type="email"
                  value={onboardingForm.email}
                  onChange={(e) => setOnboardingForm((current) => ({ ...current, email: e.target.value }))}
                />
              </label>
              <label>
                Phone
                <input
                  value={onboardingForm.phone}
                  onChange={(e) => setOnboardingForm((current) => ({ ...current, phone: e.target.value }))}
                />
              </label>

              {onboardingForm.role === "doctor" ? (
                <>
                  <label>
                    License number
                    <input
                      value={onboardingForm.doctorLicenseNumber}
                      onChange={(e) =>
                        setOnboardingForm((current) => ({ ...current, doctorLicenseNumber: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Issuing body
                    <input
                      value={onboardingForm.doctorIssuingBody}
                      onChange={(e) =>
                        setOnboardingForm((current) => ({ ...current, doctorIssuingBody: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Clinic name
                    <input
                      value={onboardingForm.doctorClinicName}
                      onChange={(e) =>
                        setOnboardingForm((current) => ({ ...current, doctorClinicName: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Practice address
                    <input
                      value={onboardingForm.doctorPracticeAddress}
                      onChange={(e) =>
                        setOnboardingForm((current) => ({ ...current, doctorPracticeAddress: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Registry URL (optional)
                    <input
                      value={onboardingForm.doctorRegistryUrl}
                      onChange={(e) =>
                        setOnboardingForm((current) => ({ ...current, doctorRegistryUrl: e.target.value }))
                      }
                    />
                  </label>
                </>
              ) : null}

              {onboardingForm.role === "pharmacy" ? (
                <>
                  <label>
                    Registered name
                    <input
                      value={onboardingForm.pharmacyRegisteredName}
                      onChange={(e) =>
                        setOnboardingForm((current) => ({ ...current, pharmacyRegisteredName: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Council registration
                    <input
                      value={onboardingForm.pharmacyCouncilReg}
                      onChange={(e) =>
                        setOnboardingForm((current) => ({ ...current, pharmacyCouncilReg: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Pharmacist in charge
                    <input
                      value={onboardingForm.pharmacyPharmacistInCharge}
                      onChange={(e) =>
                        setOnboardingForm((current) => ({ ...current, pharmacyPharmacistInCharge: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Address
                    <input
                      value={onboardingForm.pharmacyAddress}
                      onChange={(e) =>
                        setOnboardingForm((current) => ({ ...current, pharmacyAddress: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Registry URL (optional)
                    <input
                      value={onboardingForm.pharmacyRegistryUrl}
                      onChange={(e) =>
                        setOnboardingForm((current) => ({ ...current, pharmacyRegistryUrl: e.target.value }))
                      }
                    />
                  </label>
                </>
              ) : null}

              {onboardingForm.role === "courier" ? (
                <>
                  <label>
                    Vehicle type
                    <input
                      value={onboardingForm.courierVehicleType}
                      onChange={(e) =>
                        setOnboardingForm((current) => ({ ...current, courierVehicleType: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Service zone
                    <input
                      value={onboardingForm.courierServiceZone}
                      onChange={(e) =>
                        setOnboardingForm((current) => ({ ...current, courierServiceZone: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Government ID (optional)
                    <input
                      value={onboardingForm.courierGovernmentId}
                      onChange={(e) =>
                        setOnboardingForm((current) => ({ ...current, courierGovernmentId: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Address (optional)
                    <input
                      value={onboardingForm.courierAddress}
                      onChange={(e) =>
                        setOnboardingForm((current) => ({ ...current, courierAddress: e.target.value }))
                      }
                    />
                  </label>
                </>
              ) : null}

              <div className="form-row">
                <button className="primary" type="button" onClick={submitOnboardingRequest}>
                  Submit request
                </button>
                <button className="ghost" type="button" onClick={() => setShowOnboardingModal(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
