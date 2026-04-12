import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { apiFetch } from "../utils/api.js";
import GlobalFeedbackOverlay from "../components/GlobalFeedbackOverlay.jsx";

export default function AdminAccess() {
  const { apiBase, token, setAuth } = useAuth();
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [auditActor, setAuditActor] = useState("");
  const [auditAction, setAuditAction] = useState("");
  const [auditEntity, setAuditEntity] = useState("");
  const [auditSearch, setAuditSearch] = useState("");
  const [auditFrom, setAuditFrom] = useState("");
  const [auditTo, setAuditTo] = useState("");
  const [mohUsers, setMohUsers] = useState([]);
  const [mohSearch, setMohSearch] = useState("");
  const [loadingMohUsers, setLoadingMohUsers] = useState(false);
  const [updatingRoleById, setUpdatingRoleById] = useState({});
  const [lockReasonById, setLockReasonById] = useState({});
  const [updatingLockById, setUpdatingLockById] = useState({});
  const [creatingMohUser, setCreatingMohUser] = useState(false);
  const [mohFullName, setMohFullName] = useState("");
  const [mohEmail, setMohEmail] = useState("");
  const [mohPassword, setMohPassword] = useState("");
  const [mohRole, setMohRole] = useState("analyst");
  const [impersonatingId, setImpersonatingId] = useState("");
  const [policySearch, setPolicySearch] = useState("");
  const [policies, setPolicies] = useState([]);
  const [loadingPolicies, setLoadingPolicies] = useState(false);
  const [policyDraft, setPolicyDraft] = useState({
    code: "",
    name: "",
    description: "",
    status: "active",
  });
  const [policyEdits, setPolicyEdits] = useState({});
  const [savingPolicyById, setSavingPolicyById] = useState({});
  const [registrationRole, setRegistrationRole] = useState("doctor");
  const [registrationForm, setRegistrationForm] = useState({
    fullName: "",
    email: "",
    phone: "",
    doctorLicenseNumber: "",
    doctorIssuingBody: "",
    doctorIssuingCountry: "",
    doctorLicenseExpiry: "",
    doctorRegistryUrl: "",
    doctorNotarizedDocIds: "",
    doctorLicenseClass: "",
    doctorMedicalCouncilId: "",
    doctorClinicOwnershipType: "",
    doctorParish: "",
    doctorContactPhone: "",
    doctorGovernmentIdType: "",
    doctorGovernmentIdNumber: "",
    doctorProfessionalIndemnityPolicy: "",
    doctorProfessionalIndemnityExpiry: "",
    doctorSpecialty: "",
    doctorSubSpecialty: "",
    doctorDateOfBirth: "",
    clinicName: "",
    practiceAddress: "",
    pharmacyRegisteredName: "",
    pharmacyCouncilReg: "",
    pharmacyBusinessReg: "",
    pharmacistInCharge: "",
    pharmacyIssuingCountry: "",
    pharmacyLicenseExpiry: "",
    pharmacyRegistryUrl: "",
    pharmacyNotarizedDocIds: "",
    pharmacyContactPhone: "",
    pharmacyParish: "",
    pharmacyNhfParticipant: false,
    pharmacyNhfRegistryId: "",
    pharmacyControlledSubstanceLicense: "",
    pharmacyControlledSubstanceExpiry: "",
    pharmacyInsurancePolicyNumber: "",
    pharmacyInsurancePolicyExpiry: "",
    pharmacyPICLicense: "",
    pharmacyAddress: "",
    nhfOrganizationName: "",
    nhfRegistryId: "",
    nhfContactPerson: "",
    nhfIssuingCountry: "",
    nhfLicenseExpiry: "",
    nhfRegistryUrl: "",
    nhfNotarizedDocIds: "",
    nhfAddress: "",
    mohEmployeeId: "",
    mohDepartment: "",
    mohRegion: "",
    mohRole: "analyst",
    courierVehicleType: "",
    courierServiceZone: "",
    courierGovernmentIdType: "",
    courierGovernmentIdNumber: "",
    courierTrn: "",
    courierDateOfBirth: "",
    courierDriverLicenseNumber: "",
    courierDriverLicenseClass: "",
    courierDriverLicenseExpiry: "",
    courierDriverLicenseIssuingCountry: "",
    courierPoliceRecordNumber: "",
    courierPoliceRecordExpiry: "",
    courierVehiclePlateNumber: "",
    courierVehicleRegistrationNumber: "",
    courierVehicleMakeModel: "",
    courierVehicleYear: "",
    courierVehicleColor: "",
    courierVehicleInsuranceProvider: "",
    courierVehicleInsurancePolicyNumber: "",
    courierVehicleInsuranceExpiry: "",
    courierAddress: "",
    courierParish: "",
    courierEmergencyContactName: "",
    courierEmergencyContactPhone: "",
    courierEmergencyContactRelation: "",
    courierRegistryUrl: "",
    courierNotarizedDocIds: "",
  });
  const [registrations, setRegistrations] = useState([]);
  const [loadingRegistrations, setLoadingRegistrations] = useState(false);
  const [registrationSearch, setRegistrationSearch] = useState("");
  const [registrationStatus, setRegistrationStatus] = useState("pending");
  const [registrationRoleFilter, setRegistrationRoleFilter] = useState("all");
  const [decisionReasonById, setDecisionReasonById] = useState({});
  const [decisionPasswordById, setDecisionPasswordById] = useState({});
  const [decidingById, setDecidingById] = useState({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [resolverQuery, setResolverQuery] = useState("");
  const [resolverResults, setResolverResults] = useState([]);
  const [resolverLoading, setResolverLoading] = useState(false);
  const [resolverError, setResolverError] = useState("");
  const [resolverOpen, setResolverOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("admin-overview");
  const isDev = useMemo(() => import.meta.env.MODE !== "production", []);
  const pendingRegistrations = useMemo(
    () => registrations.filter((entry) => String(entry.status || "").toLowerCase() === "pending").length,
    [registrations]
  );
  const lockedMohUsers = useMemo(
    () => mohUsers.filter((entry) => Boolean(entry.mohLocked)).length,
    [mohUsers]
  );
  const policyCount = useMemo(() => policies.length, [policies]);

  const load = async () => {
    try {
      setError("");
      const query = new URLSearchParams();
      query.set("limit", "100");
      query.set("offset", "0");
      if (auditActor.trim()) query.set("actor", auditActor.trim());
      if (auditAction.trim()) query.set("action", auditAction.trim());
      if (auditEntity.trim()) query.set("entity", auditEntity.trim());
      if (auditSearch.trim()) query.set("search", auditSearch.trim());
      if (auditFrom) query.set("from", auditFrom);
      if (auditTo) query.set("to", auditTo);
      const data = await apiFetch({ apiBase, token, path: `/api/admin/audit?${query.toString()}` });
      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadMohUsers = async () => {
    try {
      setLoadingMohUsers(true);
      setError("");
      const query = new URLSearchParams();
      if (mohSearch.trim()) query.set("search", mohSearch.trim());
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/admin/moh-users${query.toString() ? `?${query.toString()}` : ""}`,
      });
      setMohUsers(data.users || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingMohUsers(false);
    }
  };

  const loadPolicies = async () => {
    try {
      setLoadingPolicies(true);
      setError("");
      const query = new URLSearchParams();
      if (policySearch.trim()) query.set("search", policySearch.trim());
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/admin/moh-policies${query.toString() ? `?${query.toString()}` : ""}`,
      });
      setPolicies(data.policies || []);
      setPolicyEdits({});
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingPolicies(false);
    }
  };

  const loadRegistrations = async () => {
    try {
      setLoadingRegistrations(true);
      setError("");
      const query = new URLSearchParams();
      if (registrationStatus) query.set("status", registrationStatus);
      if (registrationRoleFilter) query.set("role", registrationRoleFilter);
      if (registrationSearch.trim()) query.set("search", registrationSearch.trim());
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/admin/registrations?${query.toString()}`,
      });
      setRegistrations(data.registrations || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingRegistrations(false);
    }
  };

  const resolveIdentifier = async () => {
    const query = resolverQuery.trim();
    if (!query) {
      setResolverError("Enter an ID, name, or registry value.");
      setResolverResults([]);
      return;
    }
    try {
      setResolverLoading(true);
      setResolverError("");
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/admin/id-resolve?query=${encodeURIComponent(query)}`,
      });
      setResolverResults(data.results || []);
    } catch (err) {
      setResolverError(err.message);
      setResolverResults([]);
    } finally {
      setResolverLoading(false);
    }
  };

  const submitRegistration = async () => {
    try {
      setError("");
      setNotice("");
      const payload = {
        role: registrationRole,
        fullName: registrationForm.fullName,
        email: registrationForm.email,
        phone: registrationForm.phone,
        credentials: {},
      };
      if (registrationRole === "doctor") {
        payload.credentials = {
          licenseNumber: registrationForm.doctorLicenseNumber,
          issuingBody: registrationForm.doctorIssuingBody,
          issuingCountry: registrationForm.doctorIssuingCountry,
          licenseExpiry: registrationForm.doctorLicenseExpiry,
          licenseClass: registrationForm.doctorLicenseClass,
          medicalCouncilId: registrationForm.doctorMedicalCouncilId,
          registryUrl: registrationForm.doctorRegistryUrl,
          notarizedDocIds: registrationForm.doctorNotarizedDocIds,
          clinicOwnershipType: registrationForm.doctorClinicOwnershipType,
          clinicName: registrationForm.clinicName,
          practiceAddress: registrationForm.practiceAddress,
          parish: registrationForm.doctorParish,
          contactPhone: registrationForm.doctorContactPhone,
          governmentIdType: registrationForm.doctorGovernmentIdType,
          governmentIdNumber: registrationForm.doctorGovernmentIdNumber,
          professionalIndemnityPolicy: registrationForm.doctorProfessionalIndemnityPolicy,
          professionalIndemnityExpiry: registrationForm.doctorProfessionalIndemnityExpiry,
          specialty: registrationForm.doctorSpecialty,
          subSpecialty: registrationForm.doctorSubSpecialty,
          dateOfBirth: registrationForm.doctorDateOfBirth,
        };
      } else if (registrationRole === "pharmacy") {
        payload.credentials = {
          registeredName: registrationForm.pharmacyRegisteredName,
          councilReg: registrationForm.pharmacyCouncilReg,
          businessRegNumber: registrationForm.pharmacyBusinessReg,
          pharmacistInCharge: registrationForm.pharmacistInCharge,
          pharmacistInChargeLicense: registrationForm.pharmacyPICLicense,
          issuingCountry: registrationForm.pharmacyIssuingCountry,
          licenseExpiry: registrationForm.pharmacyLicenseExpiry,
          registryUrl: registrationForm.pharmacyRegistryUrl,
          notarizedDocIds: registrationForm.pharmacyNotarizedDocIds,
          address: registrationForm.pharmacyAddress,
          contactPhone: registrationForm.pharmacyContactPhone,
          parish: registrationForm.pharmacyParish,
          nhfParticipant: registrationForm.pharmacyNhfParticipant,
          nhfRegistryId: registrationForm.pharmacyNhfRegistryId,
          controlledSubstanceLicense: registrationForm.pharmacyControlledSubstanceLicense,
          controlledSubstanceExpiry: registrationForm.pharmacyControlledSubstanceExpiry,
          insurancePolicyNumber: registrationForm.pharmacyInsurancePolicyNumber,
          insurancePolicyExpiry: registrationForm.pharmacyInsurancePolicyExpiry,
        };
      } else if (registrationRole === "nhf") {
        payload.credentials = {
          organizationName: registrationForm.nhfOrganizationName,
          registryId: registrationForm.nhfRegistryId,
          contactPerson: registrationForm.nhfContactPerson,
          issuingCountry: registrationForm.nhfIssuingCountry,
          licenseExpiry: registrationForm.nhfLicenseExpiry,
          registryUrl: registrationForm.nhfRegistryUrl,
          notarizedDocIds: registrationForm.nhfNotarizedDocIds,
          address: registrationForm.nhfAddress,
        };
      } else if (registrationRole === "moh") {
        payload.credentials = {
          employeeId: registrationForm.mohEmployeeId,
          department: registrationForm.mohDepartment,
          region: registrationForm.mohRegion,
          mohRole: registrationForm.mohRole,
        };
      } else if (registrationRole === "courier") {
        payload.credentials = {
          governmentIdType: registrationForm.courierGovernmentIdType,
          governmentIdNumber: registrationForm.courierGovernmentIdNumber,
          trn: registrationForm.courierTrn,
          dateOfBirth: registrationForm.courierDateOfBirth,
          driverLicenseNumber: registrationForm.courierDriverLicenseNumber,
          driverLicenseClass: registrationForm.courierDriverLicenseClass,
          driverLicenseExpiry: registrationForm.courierDriverLicenseExpiry,
          driverLicenseIssuingCountry: registrationForm.courierDriverLicenseIssuingCountry,
          policeRecordNumber: registrationForm.courierPoliceRecordNumber,
          policeRecordExpiry: registrationForm.courierPoliceRecordExpiry,
          vehicleType: registrationForm.courierVehicleType,
          vehiclePlateNumber: registrationForm.courierVehiclePlateNumber,
          vehicleRegistrationNumber: registrationForm.courierVehicleRegistrationNumber,
          vehicleMakeModel: registrationForm.courierVehicleMakeModel,
          vehicleYear: registrationForm.courierVehicleYear,
          vehicleColor: registrationForm.courierVehicleColor,
          vehicleInsuranceProvider: registrationForm.courierVehicleInsuranceProvider,
          vehicleInsurancePolicyNumber: registrationForm.courierVehicleInsurancePolicyNumber,
          vehicleInsuranceExpiry: registrationForm.courierVehicleInsuranceExpiry,
          serviceZone: registrationForm.courierServiceZone,
          address: registrationForm.courierAddress,
          parish: registrationForm.courierParish,
          emergencyContactName: registrationForm.courierEmergencyContactName,
          emergencyContactPhone: registrationForm.courierEmergencyContactPhone,
          emergencyContactRelation: registrationForm.courierEmergencyContactRelation,
          registryUrl: registrationForm.courierRegistryUrl,
          notarizedDocIds: registrationForm.courierNotarizedDocIds,
        };
      }
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/admin/registrations",
        method: "POST",
        body: payload,
      });
      setNotice(`Registration submitted for ${data.registration?.role || ""}.`);
      setRegistrationForm((current) => ({ ...current, fullName: "", email: "", phone: "" }));
      await loadRegistrations();
    } catch (err) {
      setError(err.message);
    }
  };

  const decideRegistration = async (registrationId, decision) => {
    try {
      setDecidingById((current) => ({ ...current, [registrationId]: decision }));
      setError("");
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/admin/registrations/${encodeURIComponent(registrationId)}/decision`,
        method: "POST",
        body: {
          decision,
          reason: decisionReasonById[registrationId] || "",
          tempPassword: decisionPasswordById[registrationId] || "",
        },
      });
      setRegistrations((current) =>
        current.map((entry) => (entry.id === registrationId ? data.registration : entry))
      );
      await loadRegistrations();
    } catch (err) {
      setError(err.message);
    } finally {
      setDecidingById((current) => {
        const next = { ...current };
        delete next[registrationId];
        return next;
      });
    }
  };

  const createPolicy = async () => {
    try {
      setError("");
      setNotice("");
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/admin/moh-policies",
        method: "POST",
        body: policyDraft,
      });
      setNotice(`Created policy ${data.policy?.code || ""}`);
      setPolicyDraft({ code: "", name: "", description: "", status: "active" });
      await loadPolicies();
    } catch (err) {
      setError(err.message);
    }
  };

  const updatePolicy = async (policyId) => {
    const payload = policyEdits[policyId];
    if (!payload) return;
    try {
      setSavingPolicyById((current) => ({ ...current, [policyId]: true }));
      setError("");
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/admin/moh-policies/${encodeURIComponent(policyId)}`,
        method: "PUT",
        body: payload,
      });
      setPolicies((current) =>
        current.map((entry) => (entry.id === policyId ? data.policy : entry))
      );
      setPolicyEdits((current) => {
        const next = { ...current };
        delete next[policyId];
        return next;
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingPolicyById((current) => {
        const next = { ...current };
        delete next[policyId];
        return next;
      });
    }
  };

  const createMohUser = async () => {
    try {
      setCreatingMohUser(true);
      setError("");
      setNotice("");
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/admin/moh-users",
        method: "POST",
        body: {
          fullName: mohFullName,
          email: mohEmail,
          password: mohPassword,
          mohRole,
        },
      });
      setNotice(`Created MOH user ${data.user?.email || ""}`);
      setMohFullName("");
      setMohEmail("");
      setMohPassword("");
      setMohRole("analyst");
      await loadMohUsers();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreatingMohUser(false);
    }
  };

  const updateMohRole = async (userId, nextRole) => {
    try {
      setUpdatingRoleById((current) => ({ ...current, [userId]: true }));
      setError("");
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/admin/moh-users/${encodeURIComponent(userId)}/role`,
        method: "POST",
        body: { mohRole: nextRole },
      });
      setMohUsers((current) =>
        current.map((entry) => (entry.id === userId ? { ...entry, mohRole: data.user?.mohRole || nextRole } : entry))
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setUpdatingRoleById((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
    }
  };

  const updateMohLock = async (userId, locked) => {
    try {
      setUpdatingLockById((current) => ({ ...current, [userId]: true }));
      setError("");
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/admin/moh-users/${encodeURIComponent(userId)}/lock`,
        method: "POST",
        body: {
          locked,
          reason: lockReasonById[userId] || "",
        },
      });
      setMohUsers((current) =>
        current.map((entry) =>
          entry.id === userId
            ? {
                ...entry,
                mohLocked: data.user?.mohLocked,
                mohLockReason: data.user?.mohLockReason,
                mohLockedAt: data.user?.mohLockedAt,
                mohLockedBy: data.user?.mohLockedBy,
              }
            : entry
        )
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setUpdatingLockById((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
    }
  };

  const impersonateMoh = async (userId) => {
    try {
      setImpersonatingId(userId);
      setError("");
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/admin/impersonate/${encodeURIComponent(userId)}`,
        method: "POST",
      });
      setAuth({ token: data.token, user: data.user });
    } catch (err) {
      setError(err.message);
    } finally {
      setImpersonatingId("");
    }
  };

  useEffect(() => {
    loadMohUsers();
    loadPolicies();
    loadRegistrations();
  }, []);

  useEffect(() => {
    const ids = [
      "admin-overview",
      "admin-audit",
      "admin-registrations",
      "admin-moh-perms",
      "admin-moh-create",
      "admin-policy-catalog",
      "admin-moh-manager",
    ];
    const elements = ids.map((id) => document.getElementById(id)).filter(Boolean);
    if (!elements.length) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible.length) setActiveSection(visible[0].target.id);
      },
      { rootMargin: "-30% 0px -50% 0px", threshold: [0.15, 0.35, 0.6] }
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <section className="panel admin-shell">
      <div className="admin-page-header" id="admin-overview">
        <div>
          <span className="admin-eyebrow">Administration Console</span>
          <h2>Admin Operations</h2>
          <p className="meta">Oversee registrations, MOH access, policy governance, and audit trails.</p>
        </div>
        <div className="admin-role-card">
          <div className="admin-role-card__label">At-a-glance</div>
          <div className="admin-role-card__value">Pending registrations: {pendingRegistrations}</div>
          <div className="admin-role-card__meta">MOH users locked: {lockedMohUsers} | Policies: {policyCount}</div>
        </div>
      </div>

      <div className="admin-workspace">
        <aside className="admin-sidebar">
          <h3>Admin Workspace</h3>
          <p className="meta">Use the sidebar to jump between audit, onboarding, and MOH governance tools.</p>
          <div className="admin-sidebar-group">
            <span className="meta">Core</span>
            <nav className="admin-sidebar-nav">
              <a href="#admin-overview" className={activeSection === "admin-overview" ? "active" : ""}>
                Overview
              </a>
              <a href="#admin-audit" className={activeSection === "admin-audit" ? "active" : ""}>
                Audit Logs
                <span className="admin-sidebar-badge">{total}</span>
              </a>
              <a href="#admin-registrations" className={activeSection === "admin-registrations" ? "active" : ""}>
                Registrations
                <span className="admin-sidebar-badge">{pendingRegistrations}</span>
              </a>
            </nav>
          </div>
          <div className="admin-sidebar-group">
            <span className="meta">MOH Governance</span>
            <nav className="admin-sidebar-nav">
              <a href="#admin-moh-perms" className={activeSection === "admin-moh-perms" ? "active" : ""}>
                Role Permissions
              </a>
              <a href="#admin-moh-create" className={activeSection === "admin-moh-create" ? "active" : ""}>
                Create MOH User
              </a>
              <a href="#admin-policy-catalog" className={activeSection === "admin-policy-catalog" ? "active" : ""}>
                Policy Catalog
                <span className="admin-sidebar-badge">{policyCount}</span>
              </a>
              <a href="#admin-moh-manager" className={activeSection === "admin-moh-manager" ? "active" : ""}>
                MOH Role Manager
                <span className="admin-sidebar-badge">{lockedMohUsers}</span>
              </a>
            </nav>
          </div>
        </aside>

        <main className="admin-main">
          <section className="form" id="admin-audit">
            <div className="moh-submissions-header">
              <h3>Admin Audit</h3>
            </div>
            <div className="form-row">
        <label>
          Actor ID
          <input value={auditActor} onChange={(event) => setAuditActor(event.target.value)} placeholder="User id" />
        </label>
        <label>
          Action
          <input value={auditAction} onChange={(event) => setAuditAction(event.target.value)} placeholder="action contains..." />
        </label>
        <label>
          Entity
          <input value={auditEntity} onChange={(event) => setAuditEntity(event.target.value)} placeholder="user:123" />
        </label>
        <label>
          Search
          <input value={auditSearch} onChange={(event) => setAuditSearch(event.target.value)} placeholder="Any field" />
        </label>
        <label>
          From
          <input type="date" value={auditFrom} onChange={(event) => setAuditFrom(event.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={auditTo} onChange={(event) => setAuditTo(event.target.value)} />
        </label>
        <button className="primary" onClick={load}>
          Load audit logs
        </button>
      </div>
      <p className="meta">Total logs: {total}</p>
      <div className="queue">
        {logs.map((log) => (
          <article key={log.id} className="queue-card">
            <div>
              <div className="queue-title">{log.action}</div>
              <div className="queue-meta">
                actor: {log.actorUserId} | entity: {log.entityType}:{log.entityId}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
    <section className="form" id="admin-registrations">
        <div className="moh-submissions-header">
          <h3>Entity Registrations (Doctor / Pharmacy / Courier / NHF / MOH)</h3>
          <div className="form-row">
            <label>
              Status
              <select value={registrationStatus} onChange={(event) => setRegistrationStatus(event.target.value)}>
                <option value="pending">pending</option>
                <option value="approved">approved</option>
                <option value="rejected">rejected</option>
                <option value="all">all</option>
              </select>
            </label>
            <label>
              Role
              <select value={registrationRoleFilter} onChange={(event) => setRegistrationRoleFilter(event.target.value)}>
                <option value="all">all</option>
                <option value="doctor">doctor</option>
                <option value="pharmacy">pharmacy</option>
                <option value="courier">courier</option>
                <option value="nhf">nhf</option>
                <option value="moh">moh</option>
              </select>
            </label>
            <label>
              Search
              <input
                value={registrationSearch}
                onChange={(event) => setRegistrationSearch(event.target.value)}
                placeholder="Name, email, license, reg"
              />
            </label>
            <button className="ghost" type="button" onClick={loadRegistrations} disabled={loadingRegistrations}>
              {loadingRegistrations ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>
        <div className="form-row">
          <label>
            Role
            <select value={registrationRole} onChange={(event) => setRegistrationRole(event.target.value)}>
              <option value="doctor">doctor</option>
              <option value="pharmacy">pharmacy</option>
              <option value="courier">courier</option>
              <option value="nhf">nhf</option>
              <option value="moh">moh</option>
            </select>
          </label>
          <label>
            Full name
            <span className="form-hint">Legal name as shown on government ID.</span>
            <input
              value={registrationForm.fullName}
              onChange={(event) => setRegistrationForm((current) => ({ ...current, fullName: event.target.value }))}
            />
          </label>
          <label>
            Email
            <span className="form-hint">Used for verification, login, and admin updates.</span>
            <input
              value={registrationForm.email}
              onChange={(event) => setRegistrationForm((current) => ({ ...current, email: event.target.value }))}
            />
          </label>
          <label>
            Phone
            <span className="form-hint">Mobile number with country code.</span>
            <input
              value={registrationForm.phone}
              onChange={(event) => setRegistrationForm((current) => ({ ...current, phone: event.target.value }))}
            />
          </label>
        </div>
        {registrationRole === "doctor" ? (
          <div className="form-row">
            <label>
              License number
              <span className="form-hint">Medical license number exactly as issued.</span>
              <input
                value={registrationForm.doctorLicenseNumber}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorLicenseNumber: event.target.value }))
                }
              />
            </label>
            <label>
              Issuing body
              <span className="form-hint">Example: Medical Council of Jamaica.</span>
              <input
                value={registrationForm.doctorIssuingBody}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorIssuingBody: event.target.value }))
                }
              />
            </label>
            <label>
              Issuing country
              <span className="form-hint">Country where the license was issued.</span>
              <input
                value={registrationForm.doctorIssuingCountry}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorIssuingCountry: event.target.value }))
                }
              />
            </label>
            <label>
              License class/type
              <span className="form-hint">General, specialist, consultant, etc.</span>
              <input
                value={registrationForm.doctorLicenseClass}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorLicenseClass: event.target.value }))
                }
              />
            </label>
            <label>
              Medical council ID
              <span className="form-hint">Registry ID if listed with the council.</span>
              <input
                value={registrationForm.doctorMedicalCouncilId}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorMedicalCouncilId: event.target.value }))
                }
              />
            </label>
            <label>
              License expiry
              <span className="form-hint">Use the official expiry date on the license.</span>
              <input
                type="date"
                value={registrationForm.doctorLicenseExpiry}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorLicenseExpiry: event.target.value }))
                }
              />
            </label>
            <label>
              Registry URL
              <span className="form-hint">Public registry link if available.</span>
              <input
                value={registrationForm.doctorRegistryUrl}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorRegistryUrl: event.target.value }))
                }
                placeholder="https://"
              />
            </label>
            <label>
              Clinic ownership type
              <span className="form-hint">Solo, group, hospital, or partner.</span>
              <input
                value={registrationForm.doctorClinicOwnershipType}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorClinicOwnershipType: event.target.value }))
                }
                placeholder="solo / group / hospital"
              />
            </label>
            <label>
              Notarized doc IDs
              <span className="form-hint">IDs for notarized documents on file.</span>
              <input
                value={registrationForm.doctorNotarizedDocIds}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorNotarizedDocIds: event.target.value }))
                }
                placeholder="Comma-separated IDs"
              />
            </label>
            <label>
              Clinic name
              <span className="form-hint">Practice or clinic legal name.</span>
              <input
                value={registrationForm.clinicName}
                onChange={(event) => setRegistrationForm((current) => ({ ...current, clinicName: event.target.value }))}
              />
            </label>
            <label>
              Practice address
              <span className="form-hint">Full practice address as on records.</span>
              <input
                value={registrationForm.practiceAddress}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, practiceAddress: event.target.value }))
                }
              />
            </label>
            <label>
              Parish
              <span className="form-hint">Parish where the practice is located.</span>
              <input
                value={registrationForm.doctorParish}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorParish: event.target.value }))
                }
              />
            </label>
            <label>
              Contact phone
              <span className="form-hint">Practice contact line or admin desk.</span>
              <input
                value={registrationForm.doctorContactPhone}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorContactPhone: event.target.value }))
                }
              />
            </label>
            <label>
              Government ID type
              <span className="form-hint">Used for identity verification.</span>
              <select
                value={registrationForm.doctorGovernmentIdType}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorGovernmentIdType: event.target.value }))
                }
              >
                <option value="">Select type</option>
                <option value="National ID">National ID</option>
                <option value="Passport">Passport</option>
                <option value="Driver License">Driver License</option>
              </select>
            </label>
            <label>
              Government ID number
              <span className="form-hint">Exact ID number as shown on document.</span>
              <input
                value={registrationForm.doctorGovernmentIdNumber}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorGovernmentIdNumber: event.target.value }))
                }
              />
            </label>
            <label>
              Professional indemnity policy
              <span className="form-hint">Policy number for liability coverage.</span>
              <input
                value={registrationForm.doctorProfessionalIndemnityPolicy}
                onChange={(event) =>
                  setRegistrationForm((current) => ({
                    ...current,
                    doctorProfessionalIndemnityPolicy: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Professional indemnity expiry
              <span className="form-hint">Expiry date on the indemnity policy.</span>
              <input
                type="date"
                value={registrationForm.doctorProfessionalIndemnityExpiry}
                onChange={(event) =>
                  setRegistrationForm((current) => ({
                    ...current,
                    doctorProfessionalIndemnityExpiry: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Specialty
              <span className="form-hint">Primary clinical specialty.</span>
              <input
                value={registrationForm.doctorSpecialty}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorSpecialty: event.target.value }))
                }
              />
            </label>
            <label>
              Sub-specialty
              <span className="form-hint">Secondary specialty if applicable.</span>
              <input
                value={registrationForm.doctorSubSpecialty}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorSubSpecialty: event.target.value }))
                }
              />
            </label>
            <label>
              Date of birth
              <span className="form-hint">Date of birth for identity match.</span>
              <input
                type="date"
                value={registrationForm.doctorDateOfBirth}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, doctorDateOfBirth: event.target.value }))
                }
              />
            </label>
          </div>
        ) : null}
        {registrationRole === "pharmacy" ? (
          <div className="form-row">
            <label>
              Registered name
              <span className="form-hint">Legal registered business name.</span>
              <input
                value={registrationForm.pharmacyRegisteredName}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, pharmacyRegisteredName: event.target.value }))
                }
              />
            </label>
            <label>
              Council registration
              <span className="form-hint">Pharmacy Council registration number.</span>
              <input
                value={registrationForm.pharmacyCouncilReg}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, pharmacyCouncilReg: event.target.value }))
                }
              />
            </label>
            <label>
              Business registration
              <span className="form-hint">Company or business registration number.</span>
              <input
                value={registrationForm.pharmacyBusinessReg}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, pharmacyBusinessReg: event.target.value }))
                }
              />
            </label>
            <label>
              Pharmacist in charge
              <span className="form-hint">PIC full legal name.</span>
              <input
                value={registrationForm.pharmacistInCharge}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, pharmacistInCharge: event.target.value }))
                }
              />
            </label>
            <label>
              Pharmacist license
              <span className="form-hint">PIC license number.</span>
              <input
                value={registrationForm.pharmacyPICLicense}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, pharmacyPICLicense: event.target.value }))
                }
              />
            </label>
            <label>
              Issuing country
              <span className="form-hint">Country where the pharmacy license was issued.</span>
              <input
                value={registrationForm.pharmacyIssuingCountry}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, pharmacyIssuingCountry: event.target.value }))
                }
              />
            </label>
            <label>
              License expiry
              <span className="form-hint">Expiry date for the operating license.</span>
              <input
                type="date"
                value={registrationForm.pharmacyLicenseExpiry}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, pharmacyLicenseExpiry: event.target.value }))
                }
              />
            </label>
            <label>
              Registry URL
              <span className="form-hint">Public registry link if available.</span>
              <input
                value={registrationForm.pharmacyRegistryUrl}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, pharmacyRegistryUrl: event.target.value }))
                }
                placeholder="https://"
              />
            </label>
            <label>
              Notarized doc IDs
              <span className="form-hint">IDs for notarized documents on file.</span>
              <input
                value={registrationForm.pharmacyNotarizedDocIds}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, pharmacyNotarizedDocIds: event.target.value }))
                }
                placeholder="Comma-separated IDs"
              />
            </label>
            <label>
              Contact phone
              <span className="form-hint">Primary pharmacy contact line.</span>
              <input
                value={registrationForm.pharmacyContactPhone}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, pharmacyContactPhone: event.target.value }))
                }
              />
            </label>
            <label>
              Parish
              <span className="form-hint">Parish where the pharmacy operates.</span>
              <input
                value={registrationForm.pharmacyParish}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, pharmacyParish: event.target.value }))
                }
              />
            </label>
            <label>
              NHF participant
              <span className="form-hint">Select if enrolled with NHF.</span>
              <select
                value={registrationForm.pharmacyNhfParticipant ? "yes" : "no"}
                onChange={(event) =>
                  setRegistrationForm((current) => ({
                    ...current,
                    pharmacyNhfParticipant: event.target.value === "yes",
                  }))
                }
              >
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
            <label>
              NHF registry ID
              <span className="form-hint">NHF registry ID if applicable.</span>
              <input
                value={registrationForm.pharmacyNhfRegistryId}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, pharmacyNhfRegistryId: event.target.value }))
                }
              />
            </label>
            <label>
              Controlled substance license
              <span className="form-hint">Required if handling controlled substances.</span>
              <input
                value={registrationForm.pharmacyControlledSubstanceLicense}
                onChange={(event) =>
                  setRegistrationForm((current) => ({
                    ...current,
                    pharmacyControlledSubstanceLicense: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Controlled substance expiry
              <span className="form-hint">Expiry date for controlled substance license.</span>
              <input
                type="date"
                value={registrationForm.pharmacyControlledSubstanceExpiry}
                onChange={(event) =>
                  setRegistrationForm((current) => ({
                    ...current,
                    pharmacyControlledSubstanceExpiry: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Insurance policy number
              <span className="form-hint">Liability insurance policy number.</span>
              <input
                value={registrationForm.pharmacyInsurancePolicyNumber}
                onChange={(event) =>
                  setRegistrationForm((current) => ({
                    ...current,
                    pharmacyInsurancePolicyNumber: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Insurance policy expiry
              <span className="form-hint">Expiry date for pharmacy insurance.</span>
              <input
                type="date"
                value={registrationForm.pharmacyInsurancePolicyExpiry}
                onChange={(event) =>
                  setRegistrationForm((current) => ({
                    ...current,
                    pharmacyInsurancePolicyExpiry: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Address
              <span className="form-hint">Operating address on business records.</span>
              <input
                value={registrationForm.pharmacyAddress}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, pharmacyAddress: event.target.value }))
                }
              />
            </label>
          </div>
        ) : null}
        {registrationRole === "nhf" ? (
          <div className="form-row">
            <label>
              Organization name
              <span className="form-hint">Official NHF entity name.</span>
              <input
                value={registrationForm.nhfOrganizationName}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, nhfOrganizationName: event.target.value }))
                }
              />
            </label>
            <label>
              Registry ID
              <span className="form-hint">NHF registry or agency ID.</span>
              <input
                value={registrationForm.nhfRegistryId}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, nhfRegistryId: event.target.value }))
                }
              />
            </label>
            <label>
              Contact person
              <span className="form-hint">Primary compliance contact.</span>
              <input
                value={registrationForm.nhfContactPerson}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, nhfContactPerson: event.target.value }))
                }
              />
            </label>
            <label>
              Issuing country
              <span className="form-hint">Country where NHF is registered.</span>
              <input
                value={registrationForm.nhfIssuingCountry}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, nhfIssuingCountry: event.target.value }))
                }
              />
            </label>
            <label>
              License expiry
              <span className="form-hint">Expiry date on NHF license or approval.</span>
              <input
                type="date"
                value={registrationForm.nhfLicenseExpiry}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, nhfLicenseExpiry: event.target.value }))
                }
              />
            </label>
            <label>
              Registry URL
              <span className="form-hint">Public registry link if available.</span>
              <input
                value={registrationForm.nhfRegistryUrl}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, nhfRegistryUrl: event.target.value }))
                }
                placeholder="https://"
              />
            </label>
            <label>
              Notarized doc IDs
              <span className="form-hint">IDs for notarized documents on file.</span>
              <input
                value={registrationForm.nhfNotarizedDocIds}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, nhfNotarizedDocIds: event.target.value }))
                }
                placeholder="Comma-separated IDs"
              />
            </label>
            <label>
              Address
              <span className="form-hint">Registered office address.</span>
              <input
                value={registrationForm.nhfAddress}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, nhfAddress: event.target.value }))
                }
              />
            </label>
          </div>
        ) : null}
        {registrationRole === "moh" ? (
          <div className="form-row">
            <label>
              Employee ID
              <span className="form-hint">Official MOH staff identifier.</span>
              <input
                value={registrationForm.mohEmployeeId}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, mohEmployeeId: event.target.value }))
                }
              />
            </label>
            <label>
              Department
              <span className="form-hint">Department or unit name.</span>
              <input
                value={registrationForm.mohDepartment}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, mohDepartment: event.target.value }))
                }
              />
            </label>
            <label>
              Region
              <span className="form-hint">Assigned region or district.</span>
              <input
                value={registrationForm.mohRegion}
                onChange={(event) => setRegistrationForm((current) => ({ ...current, mohRegion: event.target.value }))}
              />
            </label>
            <label>
              MOH Role
              <span className="form-hint">Determines approval and export permissions.</span>
              <select
                value={registrationForm.mohRole}
                onChange={(event) => setRegistrationForm((current) => ({ ...current, mohRole: event.target.value }))}
              >
                <option value="analyst">analyst</option>
                <option value="auditor">auditor</option>
                <option value="supervisor">supervisor</option>
              </select>
            </label>
          </div>
        ) : null}
        {registrationRole === "courier" ? (
          <div className="form-row">
            <label>
              Government ID type
              <span className="form-hint">ID used for background verification.</span>
              <select
                value={registrationForm.courierGovernmentIdType}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierGovernmentIdType: event.target.value }))
                }
              >
                <option value="">Select type</option>
                <option value="TRN">TRN</option>
                <option value="National ID">National ID</option>
                <option value="Passport">Passport</option>
                <option value="Driver License">Driver License</option>
              </select>
            </label>
            <label>
              Government ID number
              <span className="form-hint">Exact number from the ID.</span>
              <input
                value={registrationForm.courierGovernmentIdNumber}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierGovernmentIdNumber: event.target.value }))
                }
              />
            </label>
            <label>
              TRN (optional)
              <span className="form-hint">Tax registration number if available.</span>
              <input
                value={registrationForm.courierTrn}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierTrn: event.target.value }))
                }
              />
            </label>
            <label>
              Date of birth
              <span className="form-hint">DOB for identity matching.</span>
              <input
                type="date"
                value={registrationForm.courierDateOfBirth}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierDateOfBirth: event.target.value }))
                }
              />
            </label>
            <label>
              Driver license number
              <span className="form-hint">Driver license number as issued.</span>
              <input
                value={registrationForm.courierDriverLicenseNumber}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierDriverLicenseNumber: event.target.value }))
                }
              />
            </label>
            <label>
              Driver license class
              <span className="form-hint">Class/category that matches vehicle.</span>
              <input
                value={registrationForm.courierDriverLicenseClass}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierDriverLicenseClass: event.target.value }))
                }
              />
            </label>
            <label>
              Driver license expiry
              <span className="form-hint">Expiry date on driver license.</span>
              <input
                type="date"
                value={registrationForm.courierDriverLicenseExpiry}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierDriverLicenseExpiry: event.target.value }))
                }
              />
            </label>
            <label>
              Driver license issuing country
              <span className="form-hint">Country that issued the driver license.</span>
              <input
                value={registrationForm.courierDriverLicenseIssuingCountry}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierDriverLicenseIssuingCountry: event.target.value }))
                }
              />
            </label>
            <label>
              Police record number
              <span className="form-hint">Police record certificate number.</span>
              <input
                value={registrationForm.courierPoliceRecordNumber}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierPoliceRecordNumber: event.target.value }))
                }
              />
            </label>
            <label>
              Police record expiry
              <span className="form-hint">Expiry date on police record.</span>
              <input
                type="date"
                value={registrationForm.courierPoliceRecordExpiry}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierPoliceRecordExpiry: event.target.value }))
                }
              />
            </label>
            <label>
              Vehicle type
              <span className="form-hint">Bike, car, van, etc.</span>
              <input
                value={registrationForm.courierVehicleType}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierVehicleType: event.target.value }))
                }
              />
            </label>
            <label>
              Vehicle plate number
              <span className="form-hint">License plate number.</span>
              <input
                value={registrationForm.courierVehiclePlateNumber}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierVehiclePlateNumber: event.target.value }))
                }
              />
            </label>
            <label>
              Vehicle registration number
              <span className="form-hint">Vehicle registration number.</span>
              <input
                value={registrationForm.courierVehicleRegistrationNumber}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierVehicleRegistrationNumber: event.target.value }))
                }
              />
            </label>
            <label>
              Vehicle make/model
              <span className="form-hint">Make and model of the vehicle.</span>
              <input
                value={registrationForm.courierVehicleMakeModel}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierVehicleMakeModel: event.target.value }))
                }
              />
            </label>
            <label>
              Vehicle year
              <span className="form-hint">Model year.</span>
              <input
                value={registrationForm.courierVehicleYear}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierVehicleYear: event.target.value }))
                }
              />
            </label>
            <label>
              Vehicle color
              <span className="form-hint">Vehicle color for identification.</span>
              <input
                value={registrationForm.courierVehicleColor}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierVehicleColor: event.target.value }))
                }
              />
            </label>
            <label>
              Insurance provider
              <span className="form-hint">Vehicle insurance provider.</span>
              <input
                value={registrationForm.courierVehicleInsuranceProvider}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierVehicleInsuranceProvider: event.target.value }))
                }
              />
            </label>
            <label>
              Insurance policy number
              <span className="form-hint">Policy number for vehicle insurance.</span>
              <input
                value={registrationForm.courierVehicleInsurancePolicyNumber}
                onChange={(event) =>
                  setRegistrationForm((current) => ({
                    ...current,
                    courierVehicleInsurancePolicyNumber: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Insurance expiry
              <span className="form-hint">Expiry date for vehicle insurance.</span>
              <input
                type="date"
                value={registrationForm.courierVehicleInsuranceExpiry}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierVehicleInsuranceExpiry: event.target.value }))
                }
              />
            </label>
            <label>
              Service zone
              <span className="form-hint">Primary service area for deliveries.</span>
              <input
                value={registrationForm.courierServiceZone}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierServiceZone: event.target.value }))
                }
              />
            </label>
            <label>
              Address
              <span className="form-hint">Residential address.</span>
              <input
                value={registrationForm.courierAddress}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierAddress: event.target.value }))
                }
              />
            </label>
            <label>
              Parish
              <span className="form-hint">Residential parish.</span>
              <input
                value={registrationForm.courierParish}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierParish: event.target.value }))
                }
              />
            </label>
            <label>
              Emergency contact name
              <span className="form-hint">Name of emergency contact.</span>
              <input
                value={registrationForm.courierEmergencyContactName}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierEmergencyContactName: event.target.value }))
                }
              />
            </label>
            <label>
              Emergency contact phone
              <span className="form-hint">Phone number for emergency contact.</span>
              <input
                value={registrationForm.courierEmergencyContactPhone}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierEmergencyContactPhone: event.target.value }))
                }
              />
            </label>
            <label>
              Emergency contact relation
              <span className="form-hint">Relationship to courier.</span>
              <input
                value={registrationForm.courierEmergencyContactRelation}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierEmergencyContactRelation: event.target.value }))
                }
              />
            </label>
            <label>
              Registry URL
              <span className="form-hint">Public registry link if available.</span>
              <input
                value={registrationForm.courierRegistryUrl}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierRegistryUrl: event.target.value }))
                }
                placeholder="https://"
              />
            </label>
            <label>
              Notarized doc IDs
              <span className="form-hint">IDs for notarized documents on file.</span>
              <input
                value={registrationForm.courierNotarizedDocIds}
                onChange={(event) =>
                  setRegistrationForm((current) => ({ ...current, courierNotarizedDocIds: event.target.value }))
                }
                placeholder="Comma-separated IDs"
              />
            </label>
          </div>
        ) : null}
        <button className="primary" type="button" onClick={submitRegistration}>
          Submit registration
        </button>
        <div className="queue">
          {registrations.map((entry) => (
            <article key={entry.id} className="queue-card">
              <div>
                <div className="queue-title">
                  {entry.role?.toUpperCase()} | {entry.fullName}
                </div>
                <div className="queue-meta">
                  {entry.email} | {entry.phone} | Status: {entry.status}
                </div>
                <div className="queue-meta">
                  Submitted: {entry.submittedAt ? new Date(entry.submittedAt).toLocaleString() : "n/a"}
                </div>
              </div>
              <div className="queue-actions">
                <label>
                  Decision reason
                  <input
                    value={decisionReasonById[entry.id] || ""}
                    onChange={(event) =>
                      setDecisionReasonById((current) => ({ ...current, [entry.id]: event.target.value }))
                    }
                    placeholder="Reason for approval/rejection"
                  />
                </label>
                <label>
                  Temp password (on approve)
                  <input
                    value={decisionPasswordById[entry.id] || ""}
                    onChange={(event) =>
                      setDecisionPasswordById((current) => ({ ...current, [entry.id]: event.target.value }))
                    }
                    placeholder="Default: Refillit123!"
                  />
                </label>
                <div className="form-row">
                  <button
                    className="primary"
                    type="button"
                    onClick={() => decideRegistration(entry.id, "approved")}
                    disabled={Boolean(decidingById[entry.id]) || entry.status !== "pending"}
                  >
                    {decidingById[entry.id] === "approved" ? "Approving..." : "Approve"}
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => decideRegistration(entry.id, "rejected")}
                    disabled={Boolean(decidingById[entry.id]) || entry.status !== "pending"}
                  >
                    {decidingById[entry.id] === "rejected" ? "Rejecting..." : "Reject"}
                  </button>
                </div>
              </div>
            </article>
          ))}
          {!registrations.length ? <p className="notice">No registrations yet.</p> : null}
        </div>
      </section>
      <section className="form" id="admin-moh-perms">
        <div className="moh-submissions-header">
          <h3>MOH Role Permissions</h3>
        </div>
        <div className="queue">
          <article className="queue-card">
            <div>
              <div className="queue-title">Analyst</div>
              <div className="queue-meta">View submissions, validate snapshots.</div>
            </div>
          </article>
          <article className="queue-card">
            <div>
              <div className="queue-title">Auditor</div>
              <div className="queue-meta">View + validate + download export jobs.</div>
            </div>
          </article>
          <article className="queue-card">
            <div>
              <div className="queue-title">Supervisor</div>
              <div className="queue-meta">All permissions: approve, export create, unlock, download.</div>
            </div>
          </article>
        </div>
      </section>
      <section className="form" id="admin-moh-create">
        <div className="moh-submissions-header">
          <h3>Create MOH User</h3>
        </div>
        <div className="form-row">
          <label>
            Full name
            <input value={mohFullName} onChange={(event) => setMohFullName(event.target.value)} placeholder="MOH staff name" />
          </label>
          <label>
            Email
            <input value={mohEmail} onChange={(event) => setMohEmail(event.target.value)} placeholder="moh@org.gov" />
          </label>
          <label>
            Temp password
            <input value={mohPassword} onChange={(event) => setMohPassword(event.target.value)} placeholder="Set a password" />
          </label>
          <label>
            Role
            <select value={mohRole} onChange={(event) => setMohRole(event.target.value)}>
              <option value="analyst">analyst</option>
              <option value="auditor">auditor</option>
              <option value="supervisor">supervisor</option>
            </select>
          </label>
          <button className="primary" type="button" onClick={createMohUser} disabled={creatingMohUser}>
            {creatingMohUser ? "Creating..." : "Create MOH user"}
          </button>
        </div>
      </section>
      <section className="form" id="admin-policy-catalog">
        <div className="moh-submissions-header">
          <h3>Policy Catalog</h3>
          <div className="form-row">
            <label>
              Search
              <input
                value={policySearch}
                onChange={(event) => setPolicySearch(event.target.value)}
                placeholder="Code, name, description"
              />
            </label>
            <button className="ghost" type="button" onClick={loadPolicies} disabled={loadingPolicies}>
              {loadingPolicies ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>
        <div className="form-row">
          <label>
            Code
            <input
              value={policyDraft.code}
              onChange={(event) => setPolicyDraft((current) => ({ ...current, code: event.target.value }))}
              placeholder="POLICY-YYYY.MM"
            />
          </label>
          <label>
            Name
            <input
              value={policyDraft.name}
              onChange={(event) => setPolicyDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="Policy name"
            />
          </label>
          <label>
            Description
            <input
              value={policyDraft.description}
              onChange={(event) => setPolicyDraft((current) => ({ ...current, description: event.target.value }))}
              placeholder="Summary"
            />
          </label>
          <label>
            Status
            <select
              value={policyDraft.status}
              onChange={(event) => setPolicyDraft((current) => ({ ...current, status: event.target.value }))}
            >
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </label>
          <button className="primary" type="button" onClick={createPolicy}>
            Add policy
          </button>
        </div>
        <div className="queue">
          {policies.map((policy) => {
            const draft = policyEdits[policy.id] || policy;
            return (
              <article key={policy.id} className="queue-card">
                <div>
                  <div className="queue-title">{policy.code}</div>
                  <div className="queue-meta">{policy.name}</div>
                  <div className="queue-meta">Status: {policy.status}</div>
                </div>
                <div className="queue-actions">
                  <label>
                    Code
                    <input
                      value={draft.code || ""}
                      onChange={(event) =>
                        setPolicyEdits((current) => ({
                          ...current,
                          [policy.id]: { ...draft, code: event.target.value },
                        }))
                      }
                    />
                  </label>
                  <label>
                    Name
                    <input
                      value={draft.name || ""}
                      onChange={(event) =>
                        setPolicyEdits((current) => ({
                          ...current,
                          [policy.id]: { ...draft, name: event.target.value },
                        }))
                      }
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={draft.description || ""}
                      onChange={(event) =>
                        setPolicyEdits((current) => ({
                          ...current,
                          [policy.id]: { ...draft, description: event.target.value },
                        }))
                      }
                    />
                  </label>
                  <label>
                    Status
                    <select
                      value={draft.status || "active"}
                      onChange={(event) =>
                        setPolicyEdits((current) => ({
                          ...current,
                          [policy.id]: { ...draft, status: event.target.value },
                        }))
                      }
                    >
                      <option value="active">active</option>
                      <option value="inactive">inactive</option>
                    </select>
                  </label>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => updatePolicy(policy.id)}
                    disabled={Boolean(savingPolicyById[policy.id])}
                  >
                    {savingPolicyById[policy.id] ? "Saving..." : "Save"}
                  </button>
                </div>
              </article>
            );
          })}
          {!policies.length ? <p className="notice">No policies defined yet.</p> : null}
        </div>
      </section>
      <section className="form" id="admin-moh-manager">
        <div className="moh-submissions-header">
          <h3>MOH Role Manager</h3>
          <div className="form-row">
            <label>
              Search
              <input
                value={mohSearch}
                onChange={(event) => setMohSearch(event.target.value)}
                placeholder="Name, email, platform ID"
              />
            </label>
            <button className="ghost" type="button" onClick={loadMohUsers} disabled={loadingMohUsers}>
              {loadingMohUsers ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>
        <div className="queue">
          {mohUsers.map((user) => (
            <article key={user.id} className="queue-card">
              <div>
                <div className="queue-title">{user.fullName || user.email}</div>
                <div className="queue-meta">
                  {user.email} | ID: {user.id}
                </div>
                <div className="queue-meta">Platform ID: {user.platformStaffId || "n/a"}</div>
                {user.mohLocked ? (
                  <div className="queue-meta">Locked: {user.mohLockReason || "Locked"} </div>
                ) : null}
              </div>
              <div className="queue-actions">
                <label>
                  MOH role
                  <select
                    value={user.mohRole || "analyst"}
                    onChange={(event) => updateMohRole(user.id, event.target.value)}
                    disabled={Boolean(updatingRoleById[user.id])}
                  >
                    <option value="analyst">analyst</option>
                    <option value="auditor">auditor</option>
                    <option value="supervisor">supervisor</option>
                  </select>
                </label>
                <label>
                  Lock reason
                  <input
                    value={lockReasonById[user.id] ?? user.mohLockReason ?? ""}
                    onChange={(event) =>
                      setLockReasonById((current) => ({ ...current, [user.id]: event.target.value }))
                    }
                    placeholder="Reason for lock"
                  />
                </label>
                <div className="form-row">
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => updateMohLock(user.id, true)}
                    disabled={Boolean(updatingLockById[user.id]) || Boolean(user.mohLocked)}
                  >
                    Lock
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => updateMohLock(user.id, false)}
                    disabled={Boolean(updatingLockById[user.id]) || !user.mohLocked}
                  >
                    Unlock
                  </button>
                </div>
                {isDev ? (
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => impersonateMoh(user.id)}
                    disabled={impersonatingId === user.id}
                  >
                    {impersonatingId === user.id ? "Impersonating..." : "Impersonate (dev)"}
                  </button>
                ) : null}
              </div>
            </article>
          ))}
          {!mohUsers.length ? <p className="notice">No MOH users found.</p> : null}
        </div>
      </section>
        </main>
      </div>
      <div className={`id-resolver-float ${resolverOpen ? "open" : ""}`} role="region" aria-label="Platform ID resolver">
        <button
          className="id-resolver-toggle"
          type="button"
          onClick={() => setResolverOpen((current) => !current)}
          aria-expanded={resolverOpen}
        >
          <span className="id-resolver-toggle__icon">#</span>
          <span>ID Resolver</span>
        </button>
        {resolverOpen ? (
          <>
            <div className="id-resolver-header">
              <strong>ID Resolver</strong>
              <span className="meta">Admin-only</span>
            </div>
            <div className="id-resolver-input">
              <input
                value={resolverQuery}
                onChange={(event) => setResolverQuery(event.target.value)}
                placeholder="Paste doctor/pharmacy/user ID or registry"
                onKeyDown={(event) => {
                  if (event.key === "Enter") resolveIdentifier();
                }}
              />
              <button className="primary" type="button" onClick={resolveIdentifier} disabled={resolverLoading}>
                {resolverLoading ? "Searching..." : "Resolve"}
              </button>
            </div>
            {resolverError ? <p className="notice error">{resolverError}</p> : null}
            <div className="id-resolver-results">
              {resolverResults.map((result) => (
                <article key={`${result.type}-${result.id}`} className="id-resolver-card">
                  <div className="queue-title">
                    {result.name} <span className="meta">({result.type})</span>
                  </div>
                  <div className="queue-meta">ID: {result.id}</div>
                  {result.platformId ? <div className="queue-meta">Platform ID: {result.platformId}</div> : null}
                  {result.email ? <div className="queue-meta">Email: {result.email}</div> : null}
                  {result.licenseNumber ? <div className="queue-meta">License: {result.licenseNumber}</div> : null}
                  {result.councilReg ? <div className="queue-meta">Council Reg: {result.councilReg}</div> : null}
                  {result.registryId ? <div className="queue-meta">Registry ID: {result.registryId}</div> : null}
                </article>
              ))}
              {!resolverResults.length && !resolverError ? <p className="notice">No matches yet.</p> : null}
            </div>
          </>
        ) : null}
      </div>
      <GlobalFeedbackOverlay
        successMessage={notice}
        errorMessage={error}
        onClose={() => {
          setNotice("");
          setError("");
        }}
      />
    </section>
  );
}
