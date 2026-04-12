import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { apiFetch } from "../utils/api.js";
import GlobalFeedbackOverlay from "../components/GlobalFeedbackOverlay.jsx";

const money = (value) => Number(value || 0).toFixed(2);
const formatTimelineTime = (value) => {
  const parsed = new Date(value || "");
  if (Number.isNaN(parsed.getTime())) return "n/a";
  return parsed.toLocaleString();
};

export default function NhfClaims() {
  const { apiBase, token, role, user } = useAuth();
  const [claims, setClaims] = useState([]);
  const [summary, setSummary] = useState(null);
  const [filters, setFilters] = useState({
    status: "",
    query: "",
  });
  const [claimDraftById, setClaimDraftById] = useState({});
  const [payouts, setPayouts] = useState({
    totals: null,
    doctorPayouts: [],
    pharmacyPayouts: [],
  });
  const [slaQueue, setSlaQueue] = useState({
    summary: null,
    buckets: [],
    overdueClaims: [],
    exceptionHotlist: [],
    openDisputes: [],
  });
  const [selectedSlaClaimIds, setSelectedSlaClaimIds] = useState([]);
  const [selectedSlaExceptionKeys, setSelectedSlaExceptionKeys] = useState([]);
  const [bulkClaimStatus, setBulkClaimStatus] = useState("pending");
  const [bulkClaimNote, setBulkClaimNote] = useState("");
  const [bulkExceptionNote, setBulkExceptionNote] = useState("");
  const [bulkActionLoading, setBulkActionLoading] = useState("");
  const [reconciliation, setReconciliation] = useState({ summary: null, rows: [] });
  const [exceptions, setExceptions] = useState({ summary: null, rows: [] });
  const [payoutRuns, setPayoutRuns] = useState([]);
  const [payoutRunDraft, setPayoutRunDraft] = useState({ label: "", from: "", to: "" });
  const [disputes, setDisputes] = useState([]);
  const [disputeDraft, setDisputeDraft] = useState({
    claimId: "",
    payoutRunId: "",
    reason: "",
    notes: "",
  });
  const [calculatorForm, setCalculatorForm] = useState({
    appointmentId: "",
    baseAmount: 0,
    coveragePercent: 70,
    coverageCap: 0,
    deductible: 0,
    alreadyPaid: 0,
    doctorSharePercent: 100,
    pharmacySharePercent: 100,
  });
  const [calculatorResult, setCalculatorResult] = useState(null);

  const [prescId, setPrescId] = useState("");
  const [orderId, setOrderId] = useState("");
  const [patientNhfId, setPatientNhfId] = useState("");
  const [amountCovered, setAmountCovered] = useState(0);

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [resolvingKey, setResolvingKey] = useState("");
  const [secondaryApprovalDraft, setSecondaryApprovalDraft] = useState({
    secondarySignerId: "",
    secondaryAuthCode: "",
    note: "",
  });
  const [activeSection, setActiveSection] = useState("nhf-overview");
  const downloadFile = async ({ path, filename, contentType = "text/csv;charset=utf-8" }) => {
    const response = await fetch(`${apiBase}${path}`, {
      method: "GET",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    const normalized = blob.slice(0, blob.size, contentType);
    const url = URL.createObjectURL(normalized);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const isNhfAgent = useMemo(() => ["nhf", "admin"].includes(String(role || "").toLowerCase()), [role]);
  const nhfSubRole = useMemo(
    () => String(user?.nhfRole || "analyst").trim().toLowerCase(),
    [user?.nhfRole]
  );
  const nhfRolePermissions = useMemo(
    () => ({
      analyst: new Set(["claims.read", "calculator.use", "reconciliation.read", "exceptions.read"]),
      reviewer: new Set([
        "claims.read",
        "claims.update",
        "calculator.use",
        "reconciliation.read",
        "reconciliation.resolve",
        "exceptions.read",
        "exceptions.resolve",
        "disputes.read",
        "disputes.create",
        "disputes.update",
      ]),
      finance: new Set([
        "claims.read",
        "claims.export",
        "payouts.read",
        "payouts.runs.read",
        "payouts.runs.create",
        "payouts.runs.transition",
        "payouts.runs.export",
        "disputes.read",
      ]),
      supervisor: new Set([
        "claims.read",
        "claims.update",
        "claims.export",
        "calculator.use",
        "payouts.read",
        "payouts.runs.read",
        "payouts.runs.create",
        "payouts.runs.transition",
        "payouts.runs.export",
        "reconciliation.read",
        "reconciliation.resolve",
        "exceptions.read",
        "exceptions.resolve",
        "disputes.read",
        "disputes.create",
        "disputes.update",
      ]),
      auditor: new Set([
        "claims.read",
        "claims.export",
        "payouts.read",
        "payouts.runs.read",
        "payouts.runs.export",
        "reconciliation.read",
        "exceptions.read",
        "disputes.read",
      ]),
    }),
    []
  );
  const can = (permission) => {
    const mainRole = String(role || "").toLowerCase();
    if (mainRole === "admin") return true;
    if (mainRole !== "nhf") return false;
    const perms = nhfRolePermissions[nhfSubRole] || nhfRolePermissions.analyst;
    return perms.has(permission);
  };
  const agentIdentity = [
    user?.fullName || null,
    user?.email || null,
    user?.id ? `ID: ${user.id}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
  const buildSecondaryApproval = () => ({
    secondarySignerId: secondaryApprovalDraft.secondarySignerId.trim(),
    secondaryAuthCode: secondaryApprovalDraft.secondaryAuthCode.trim(),
    note: secondaryApprovalDraft.note.trim() || undefined,
  });
  const requireSecondaryApproval = (actionLabel) => {
    const signer = secondaryApprovalDraft.secondarySignerId.trim();
    const code = secondaryApprovalDraft.secondaryAuthCode.trim();
    if (!signer || !code) {
      setError(`Secondary approval is required for ${actionLabel}.`);
      return false;
    }
    if (!/^\d{6}$/.test(code)) {
      setError("Secondary auth code must be a 6-digit code.");
      return false;
    }
    return true;
  };
  const pendingClaimsCount = Number(summary?.pending || 0);
  const exceptionsCount = Number(exceptions?.summary?.total || exceptions?.rows?.length || 0);
  const openDisputesCount = disputes.filter(
    (entry) => String(entry.status || "").toLowerCase() === "open"
  ).length;
  const renderResolutionHistory = (row) => {
    const history = Array.isArray(row?.resolutionHistory) ? row.resolutionHistory.slice(0, 5) : [];
    if (!history.length) return <div className="queue-meta">Resolution history: none</div>;
    return (
      <div className="queue-meta">
        <strong>Resolution history</strong>
        {history.map((event) => {
          const actor = event.actorNhfRole
            ? `${event.actorNhfRole} (${event.actorUserId || "unknown"})`
            : (event.actorUserId || "unknown");
          const secondary = event.secondarySignerId ? ` | secondary ${event.secondarySignerId}` : "";
          return (
            <div key={event.id || `${event.resolvedAt}-${event.action}-${event.outcome}`}>
              {formatTimelineTime(event.resolvedAt || event.createdAt)} | {event.action || "unknown action"} |{" "}
              {event.outcome || "completed"} | by {actor}
              {secondary}
            </div>
          );
        })}
      </div>
    );
  };

  const loadClaims = async () => {
    try {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.query.trim()) params.set("query", filters.query.trim());
      const query = params.toString() ? `?${params.toString()}` : "";
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/nhf/claims${query}`,
      });
      setClaims(data.claims || []);
      setSummary(data.summary || null);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadPayouts = async () => {
    try {
      if (!can("payouts.read")) {
        setPayouts({ totals: null, doctorPayouts: [], pharmacyPayouts: [] });
        return;
      }
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/payouts/summary",
      });
      setPayouts({
        totals: data.totals || null,
        doctorPayouts: data.doctorPayouts || [],
        pharmacyPayouts: data.pharmacyPayouts || [],
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const loadSlaQueue = async () => {
    try {
      if (!can("claims.read") || !can("exceptions.read") || !can("disputes.read")) {
        setSlaQueue({
          summary: null,
          buckets: [],
          overdueClaims: [],
          exceptionHotlist: [],
          openDisputes: [],
        });
        return;
      }
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/sla-queue",
      });
      setSlaQueue({
        summary: data.summary || null,
        buckets: data.buckets || [],
        overdueClaims: data.overdueClaims || [],
        exceptionHotlist: data.exceptionHotlist || [],
        openDisputes: data.openDisputes || [],
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const loadReconciliation = async () => {
    try {
      if (!can("reconciliation.read")) {
        setReconciliation({ summary: null, rows: [] });
        return;
      }
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/reconciliation",
      });
      setReconciliation({ summary: data.summary || null, rows: data.rows || [] });
    } catch (err) {
      setError(err.message);
    }
  };

  const loadExceptions = async () => {
    try {
      if (!can("exceptions.read")) {
        setExceptions({ summary: null, rows: [] });
        return;
      }
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/exceptions",
      });
      setExceptions({ summary: data.summary || null, rows: data.exceptions || [] });
    } catch (err) {
      setError(err.message);
    }
  };

  const loadPayoutRuns = async () => {
    try {
      if (!can("payouts.runs.read")) {
        setPayoutRuns([]);
        return;
      }
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/payout-runs",
      });
      setPayoutRuns(data.payoutRuns || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const createPayoutRun = async () => {
    try {
      if (!can("payouts.runs.create")) {
        setError("Your NHF role cannot create payout runs.");
        return;
      }
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/payout-runs",
        method: "POST",
        body: {
          label: payoutRunDraft.label || undefined,
          from: payoutRunDraft.from || undefined,
          to: payoutRunDraft.to || undefined,
        },
      });
      setMessage(`Payout run created: ${data.payoutRun.id}`);
      await loadPayoutRuns();
    } catch (err) {
      setError(err.message);
    }
  };

  const advancePayoutRunStatus = async (run) => {
    try {
      if (!can("payouts.runs.transition")) {
        setError("Your NHF role cannot transition payout runs.");
        return;
      }
      const nextStatus =
        run.status === "draft"
          ? "approved"
          : run.status === "approved"
            ? "paid"
            : run.status === "paid"
              ? "exported"
              : run.status;
      if (nextStatus === run.status) return;
      const needsSecondary = ["paid", "exported"].includes(nextStatus);
      if (needsSecondary && !requireSecondaryApproval(`payout run transition to ${nextStatus}`)) return;
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/nhf/payout-runs/${run.id}/status`,
        method: "PATCH",
        body: {
          status: nextStatus,
          ...(needsSecondary ? { secondaryApproval: buildSecondaryApproval() } : {}),
        },
      });
      setMessage(`Payout run ${data.payoutRun.id} moved to ${data.payoutRun.status}.`);
      await loadPayoutRuns();
    } catch (err) {
      setError(err.message);
    }
  };

  const exportPayoutRunCsv = async (runId) => {
    try {
      if (!can("payouts.runs.export")) {
        setError("Your NHF role cannot export payout runs.");
        return;
      }
      await downloadFile({
        path: `/api/nhf/payout-runs/${runId}/export.csv`,
        filename: `nhf-payout-run-${runId}.csv`,
      });
      setMessage(`Payout run ${runId} exported.`);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadDisputes = async () => {
    try {
      if (!can("disputes.read")) {
        setDisputes([]);
        return;
      }
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/disputes",
      });
      setDisputes(data.disputes || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const createDispute = async () => {
    try {
      if (!can("disputes.create")) {
        setError("Your NHF role cannot create disputes.");
        return;
      }
      if (!disputeDraft.reason.trim()) {
        setError("Dispute reason is required.");
        return;
      }
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/disputes",
        method: "POST",
        body: {
          claimId: disputeDraft.claimId || undefined,
          payoutRunId: disputeDraft.payoutRunId || undefined,
          reason: disputeDraft.reason,
          notes: disputeDraft.notes || undefined,
        },
      });
      setMessage(`Dispute created: ${data.dispute.id}`);
      setDisputeDraft({ claimId: "", payoutRunId: "", reason: "", notes: "" });
      await Promise.all([loadDisputes(), loadSlaQueue()]);
    } catch (err) {
      setError(err.message);
    }
  };

  const updateDisputeStatus = async (dispute, status) => {
    try {
      if (!can("disputes.update")) {
        setError("Your NHF role cannot update disputes.");
        return;
      }
      await apiFetch({
        apiBase,
        token,
        path: `/api/nhf/disputes/${dispute.id}`,
        method: "PATCH",
        body: { status },
      });
      setMessage(`Dispute ${dispute.id} updated to ${status}.`);
      await Promise.all([loadDisputes(), loadSlaQueue()]);
    } catch (err) {
      setError(err.message);
    }
  };

  const resolveReconciliationRow = async (row, resolution) => {
    const key = `rec:${row.type}:${row.entityId || row.claimId || "x"}`;
    setResolvingKey(key);
    try {
      if (!can("reconciliation.resolve")) {
        setError("Your NHF role cannot resolve reconciliation issues.");
        return;
      }
      const needsSecondary = ["sync_claim_to_expected", "reject_claim"].includes(resolution);
      if (needsSecondary && !requireSecondaryApproval(`reconciliation action '${resolution}'`)) return;
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/reconciliation/resolve",
        method: "POST",
        body: {
          resolution,
          type: row.type,
          entityType: row.entityType,
          entityId: row.entityId,
          claimId: row.claimId || undefined,
          expectedAmount: row.expectedAmount,
          ...(needsSecondary ? { secondaryApproval: buildSecondaryApproval() } : {}),
        },
      });
      setMessage(`Reconciliation resolved: ${data.action}.`);
      await Promise.all([loadReconciliation(), loadClaims(), loadDisputes(), loadExceptions(), loadSlaQueue()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setResolvingKey("");
    }
  };

  const resolveExceptionRow = async (entry, resolution) => {
    const key = `exc:${entry.type}:${entry.claimId || entry.orderId || entry.appointmentId || "x"}`;
    setResolvingKey(key);
    try {
      if (!can("exceptions.resolve")) {
        setError("Your NHF role cannot resolve exceptions.");
        return;
      }
      const needsSecondary = ["cap_to_base_amount", "keep_latest_reject_others"].includes(resolution);
      if (needsSecondary && !requireSecondaryApproval(`exception action '${resolution}'`)) return;
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/exceptions/resolve",
        method: "POST",
        body: {
          resolution,
          type: entry.type,
          claimId: entry.claimId || undefined,
          claimIds: entry.claimIds || undefined,
          appointmentId: entry.appointmentId || undefined,
          orderId: entry.orderId || undefined,
          ...(needsSecondary ? { secondaryApproval: buildSecondaryApproval() } : {}),
        },
      });
      setMessage(`Exception resolved: ${data.action}.`);
      await Promise.all([loadExceptions(), loadClaims(), loadDisputes(), loadReconciliation(), loadSlaQueue()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setResolvingKey("");
    }
  };

  const updateClaim = async (claim) => {
    try {
      if (!can("claims.update")) {
        setError("Your NHF role cannot update claims.");
        return;
      }
      const draft = claimDraftById[claim.id] || {};
      const hasStatusChange =
        Object.prototype.hasOwnProperty.call(draft, "status")
        && String(draft.status || "").toLowerCase() !== String(claim.status || "").toLowerCase();
      const hasAmountChange =
        Object.prototype.hasOwnProperty.call(draft, "amountCovered")
        && Number(draft.amountCovered) !== Number(claim.amountCovered || 0);
      const nextStatus = hasStatusChange
        ? String(draft.status || "").toLowerCase()
        : String(claim.status || "").toLowerCase();
      const needsSecondary =
        ["approved", "rejected"].includes(nextStatus)
        || hasAmountChange;
      const body = {
        ...(hasStatusChange ? { status: draft.status } : {}),
        ...(hasAmountChange ? { amountCovered: Number(draft.amountCovered || 0) } : {}),
        ...(Object.prototype.hasOwnProperty.call(draft, "reviewNote")
          ? { reviewNote: String(draft.reviewNote || "") }
          : {}),
        ...(needsSecondary ? { secondaryApproval: buildSecondaryApproval() } : {}),
      };
      if (!Object.keys(body).length) {
        setMessage(`No claim changes to submit for ${claim.id}.`);
        return;
      }
      if (needsSecondary && !requireSecondaryApproval("claim adjudication")) return;
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/nhf/claims/${claim.id}`,
        method: "PATCH",
        body,
      });
      setMessage(`Claim updated: ${data.claim.id}`);
      await Promise.all([loadClaims(), loadPayouts(), loadSlaQueue()]);
    } catch (err) {
      setError(err.message);
    }
  };

  const runCalculator = async () => {
    try {
      if (!can("calculator.use")) {
        setError("Your NHF role cannot use calculator.");
        return;
      }
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/calculator/preview",
        method: "POST",
        body: {
          appointmentId: calculatorForm.appointmentId || undefined,
          baseAmount: Number(calculatorForm.baseAmount || 0),
          coveragePercent: Number(calculatorForm.coveragePercent || 0),
          coverageCap: Number(calculatorForm.coverageCap || 0),
          deductible: Number(calculatorForm.deductible || 0),
          alreadyPaid: Number(calculatorForm.alreadyPaid || 0),
          doctorSharePercent: Number(calculatorForm.doctorSharePercent || 0),
          pharmacySharePercent: Number(calculatorForm.pharmacySharePercent || 0),
        },
      });
      setCalculatorResult(data);
      setMessage("NHF calculator result generated.");
    } catch (err) {
      setError(err.message);
    }
  };

  const exportClaimsCsv = async () => {
    try {
      if (!can("claims.export")) {
        setError("Your NHF role cannot export claims.");
        return;
      }
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.query.trim()) params.set("query", filters.query.trim());
      const query = params.toString() ? `?${params.toString()}` : "";
      await downloadFile({
        path: `/api/nhf/claims/export.csv${query}`,
        filename: `nhf-claims-${new Date().toISOString().slice(0, 10)}.csv`,
      });
      setMessage("NHF claims CSV exported.");
    } catch (err) {
      setError(err.message);
    }
  };

  const submitPatientClaim = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/claims",
        method: "POST",
        body: {
          prescId,
          orderId,
          patientNhfId: patientNhfId || null,
          amountCovered: Number(amountCovered),
        },
      });
      setMessage(`Claim submitted: ${data.claim.id}`);
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleSlaClaimSelection = (claimId) => {
    setSelectedSlaClaimIds((current) =>
      current.includes(claimId) ? current.filter((id) => id !== claimId) : [...current, claimId]
    );
  };

  const toggleSlaExceptionSelection = (key) => {
    setSelectedSlaExceptionKeys((current) =>
      current.includes(key) ? current.filter((id) => id !== key) : [...current, key]
    );
  };

  const runBulkClaimUpdate = async () => {
    try {
      if (!can("claims.update")) {
        setError("Your NHF role cannot run claim bulk actions.");
        return;
      }
      if (!selectedSlaClaimIds.length) {
        setError("Select at least one claim from SLA queue.");
        return;
      }
      const needsSecondary = ["approved", "rejected"].includes(String(bulkClaimStatus || "").toLowerCase());
      if (needsSecondary && !requireSecondaryApproval("claim bulk adjudication")) return;
      setBulkActionLoading("claims");
      const payload = {
        claimIds: selectedSlaClaimIds,
        status: bulkClaimStatus,
        reviewNote: bulkClaimNote || undefined,
        ...(needsSecondary ? { secondaryApproval: buildSecondaryApproval() } : {}),
      };
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/claims/bulk-update",
        method: "POST",
        body: payload,
      });
      setMessage(`Bulk claims updated: ${data.updatedCount} success, ${data.missingCount} missing.`);
      setSelectedSlaClaimIds([]);
      await Promise.all([loadClaims(), loadSlaQueue(), loadPayouts()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkActionLoading("");
    }
  };

  const runBulkExceptionResolve = async () => {
    try {
      if (!can("exceptions.resolve")) {
        setError("Your NHF role cannot run exception bulk actions.");
        return;
      }
      if (!selectedSlaExceptionKeys.length) {
        setError("Select at least one exception from SLA queue.");
        return;
      }
      const selectedRows = slaQueue.exceptionHotlist.filter((entry) =>
        selectedSlaExceptionKeys.includes(`${entry.type}:${entry.claimId || ""}`)
      );
      if (!selectedRows.length) {
        setError("Selected exception rows are no longer available.");
        return;
      }
      const grouped = selectedRows.reduce((acc, entry) => {
        const type = String(entry.type || "").trim().toLowerCase();
        const resolution = String(entry.suggestedResolution || "").trim().toLowerCase();
        const claimId = String(entry.claimId || "").trim();
        if (!type || !resolution || !claimId) return acc;
        const groupKey = `${type}|${resolution}`;
        if (!acc[groupKey]) acc[groupKey] = { type, resolution, claimIds: [] };
        acc[groupKey].claimIds.push(claimId);
        return acc;
      }, {});
      const groups = Object.values(grouped).filter((entry) => entry.claimIds.length);
      if (!groups.length) {
        setError("Selected exceptions do not support bulk auto-resolution.");
        return;
      }

      const needsSecondary = groups.some((entry) => entry.resolution === "cap_to_base_amount");
      if (needsSecondary && !requireSecondaryApproval("exception bulk resolution")) return;

      setBulkActionLoading("exceptions");
      let resolvedTotal = 0;
      for (const group of groups) {
        // eslint-disable-next-line no-await-in-loop
        const data = await apiFetch({
          apiBase,
          token,
          path: "/api/nhf/exceptions/bulk-resolve",
          method: "POST",
          body: {
            type: group.type,
            resolution: group.resolution,
            claimIds: group.claimIds,
            reviewNote: bulkExceptionNote || undefined,
            ...(needsSecondary ? { secondaryApproval: buildSecondaryApproval() } : {}),
          },
        });
        resolvedTotal += Number(data.resolvedCount || 0);
      }
      setMessage(`Bulk exceptions resolved: ${resolvedTotal}.`);
      setSelectedSlaExceptionKeys([]);
      await Promise.all([loadExceptions(), loadClaims(), loadDisputes(), loadReconciliation(), loadSlaQueue()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkActionLoading("");
    }
  };

  useEffect(() => {
    if (!isNhfAgent) return;
    Promise.all([
      loadClaims(),
      loadSlaQueue(),
      loadPayouts(),
      loadReconciliation(),
      loadExceptions(),
      loadPayoutRuns(),
      loadDisputes(),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNhfAgent]);

  useEffect(() => {
    if (!isNhfAgent) return undefined;
    const ids = [
      "nhf-overview",
      "nhf-sla",
      "nhf-approvals",
      "nhf-claims",
      "nhf-calculator",
      "nhf-payout-summary",
      "nhf-reconciliation",
      "nhf-exceptions",
      "nhf-payout-runs",
      "nhf-disputes",
    ];
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter(Boolean);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNhfAgent]);

  if (isNhfAgent) {
    return (
      <section className="panel nhf-shell">
        <div className="nhf-page-header" id="nhf-overview">
          <div>
            <span className="nhf-eyebrow">National Health Fund Operations</span>
            <h2>NHF Operations</h2>
            <p className="meta">
              Manage claims adjudication, reconciliation, exceptions, payout runs, and disputes from one workspace.
            </p>
          </div>
          <div className="nhf-role-card">
            <div className="nhf-role-card__label">Signed in agent</div>
            <div className="nhf-role-card__value">{agentIdentity || "Unknown"}</div>
            <div className="nhf-role-card__meta">
              Role: {String(role || "").toLowerCase() === "admin" ? "admin (full access)" : nhfSubRole}
            </div>
            <div className="nhf-role-card__summary">
              Claims: {summary?.total || 0} | Pending: {summary?.pending || 0} | Approved:{" "}
              {summary?.approved || 0}
            </div>
          </div>
        </div>

        <div className="nhf-workspace">
          <aside className="nhf-sidebar">
            <h3>NHF Workspace</h3>
            <p className="meta">Use categories to jump quickly across payment, reconciliation, and dispute workflows.</p>
            <div className="nhf-sidebar-group">
              <span className="meta">Core</span>
              <nav className="nhf-sidebar-nav">
                <a href="#nhf-overview" className={activeSection === "nhf-overview" ? "active" : ""}>Overview</a>
                <a href="#nhf-sla" className={activeSection === "nhf-sla" ? "active" : ""}>SLA Queue</a>
                <a href="#nhf-approvals" className={activeSection === "nhf-approvals" ? "active" : ""}>Dual Signature</a>
                <a href="#nhf-claims" className={activeSection === "nhf-claims" ? "active" : ""}>
                  Claims
                  <span className="nhf-sidebar-badge">{pendingClaimsCount}</span>
                </a>
                <a href="#nhf-calculator" className={activeSection === "nhf-calculator" ? "active" : ""}>Calculator</a>
              </nav>
            </div>
            <div className="nhf-sidebar-group">
              <span className="meta">Risk & Control</span>
              <nav className="nhf-sidebar-nav">
                <a href="#nhf-reconciliation" className={activeSection === "nhf-reconciliation" ? "active" : ""}>Reconciliation</a>
                <a href="#nhf-exceptions" className={activeSection === "nhf-exceptions" ? "active" : ""}>
                  Exceptions
                  <span className="nhf-sidebar-badge">{exceptionsCount}</span>
                </a>
                <a href="#nhf-disputes" className={activeSection === "nhf-disputes" ? "active" : ""}>
                  Disputes
                  <span className="nhf-sidebar-badge">{openDisputesCount}</span>
                </a>
              </nav>
            </div>
            <div className="nhf-sidebar-group">
              <span className="meta">Finance</span>
              <nav className="nhf-sidebar-nav">
                <a href="#nhf-payout-summary" className={activeSection === "nhf-payout-summary" ? "active" : ""}>Payout Summary</a>
                <a href="#nhf-payout-runs" className={activeSection === "nhf-payout-runs" ? "active" : ""}>Payout Runs</a>
              </nav>
            </div>
          </aside>

          <main className="nhf-main">
            {can("claims.update") || can("reconciliation.resolve") || can("exceptions.resolve")
            || can("payouts.runs.transition") ? (
              <section className="form" id="nhf-approvals">
              <h3>Secondary Approval (Dual Signature)</h3>
              <div className="doctor-reminder-grid">
                <label>
                  Secondary signer user ID
                  <input
                    value={secondaryApprovalDraft.secondarySignerId}
                    onChange={(e) =>
                      setSecondaryApprovalDraft((current) => ({
                        ...current,
                        secondarySignerId: e.target.value,
                      }))
                    }
                    placeholder="Required for sensitive actions"
                  />
                </label>
                <label>
                  Secondary auth code
                  <input
                    value={secondaryApprovalDraft.secondaryAuthCode}
                    onChange={(e) =>
                      setSecondaryApprovalDraft((current) => ({
                        ...current,
                        secondaryAuthCode: e.target.value,
                      }))
                    }
                    placeholder="6-digit code"
                  />
                </label>
                <label>
                  Approval note
                  <input
                    value={secondaryApprovalDraft.note}
                    onChange={(e) =>
                      setSecondaryApprovalDraft((current) => ({ ...current, note: e.target.value }))
                    }
                    placeholder="Optional"
                  />
                </label>
              </div>
            </section>
          ) : null}

        <section className="form" id="nhf-sla">
          <h3>SLA Queue + Bulk Actions</h3>
          <div className="form-row">
            <button className="ghost" type="button" onClick={loadSlaQueue}>
              Refresh SLA queue
            </button>
            <span className="meta">
              Pending: {slaQueue.summary?.pendingClaims || 0} | Over 24h: {slaQueue.summary?.overdue24h || 0} | Over 48h:{" "}
              {slaQueue.summary?.overdue48h || 0} | Exceptions: {slaQueue.summary?.exceptionTotal || 0} | Open disputes:{" "}
              {slaQueue.summary?.openDisputes || 0}
            </span>
          </div>
          <div className="doctor-reminder-grid">
            {slaQueue.buckets.map((bucket) => (
              <div key={bucket.bucket} className="notice">
                {bucket.label}: <strong>{bucket.count}</strong>
              </div>
            ))}
          </div>

          <h4>Overdue Claims</h4>
          <div className="form-row">
            <button
              className="ghost"
              type="button"
              onClick={() => setSelectedSlaClaimIds(slaQueue.overdueClaims.map((entry) => entry.claimId))}
            >
              Select all
            </button>
            <button className="ghost" type="button" onClick={() => setSelectedSlaClaimIds([])}>
              Clear selection
            </button>
            <span className="meta">Selected: {selectedSlaClaimIds.length}</span>
          </div>
          <div className="queue">
            {slaQueue.overdueClaims.slice(0, 30).map((entry) => (
              <article key={entry.claimId} className="queue-card">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={selectedSlaClaimIds.includes(entry.claimId)}
                    onChange={() => toggleSlaClaimSelection(entry.claimId)}
                  />
                  Claim {entry.claimId}
                </label>
                <div className="queue-meta">
                  Status: {entry.status} | Age: {entry.ageHours}h | Patient: {entry.patientName || "n/a"}
                </div>
              </article>
            ))}
            {!slaQueue.overdueClaims.length ? <div className="meta">No pending claims in SLA queue.</div> : null}
          </div>
          <div className="form-row">
            <label>
              Bulk claim status
              <select value={bulkClaimStatus} onChange={(e) => setBulkClaimStatus(e.target.value)}>
                <option value="pending">pending</option>
                <option value="approved">approved</option>
                <option value="rejected">rejected</option>
              </select>
            </label>
            <label>
              Bulk claim note
              <input
                value={bulkClaimNote}
                onChange={(e) => setBulkClaimNote(e.target.value)}
                placeholder="Optional note"
              />
            </label>
            <button
              className="primary"
              type="button"
              onClick={runBulkClaimUpdate}
              disabled={bulkActionLoading === "claims" || !can("claims.update")}
            >
              {bulkActionLoading === "claims" ? "Applying..." : "Apply to selected claims"}
            </button>
          </div>

          <h4>Exception Hotlist</h4>
          <div className="form-row">
            <button
              className="ghost"
              type="button"
              onClick={() =>
                setSelectedSlaExceptionKeys(
                  slaQueue.exceptionHotlist
                    .filter((entry) => entry.claimId && entry.suggestedResolution)
                    .map((entry) => `${entry.type}:${entry.claimId}`)
                )
              }
            >
              Select auto-resolvable
            </button>
            <button className="ghost" type="button" onClick={() => setSelectedSlaExceptionKeys([])}>
              Clear selection
            </button>
            <span className="meta">Selected: {selectedSlaExceptionKeys.length}</span>
          </div>
          <div className="queue">
            {slaQueue.exceptionHotlist.slice(0, 30).map((entry, idx) => {
              const key = `${entry.type}:${entry.claimId || idx}`;
              return (
                <article key={key} className="queue-card">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={selectedSlaExceptionKeys.includes(key)}
                      onChange={() => toggleSlaExceptionSelection(key)}
                      disabled={!entry.claimId || !entry.suggestedResolution}
                    />
                    {entry.type}
                  </label>
                  <div className="queue-meta">
                    Severity: {entry.severity} | Claim: {entry.claimId || "n/a"}
                  </div>
                  <div className="queue-meta">
                    Suggested: {entry.suggestedResolution || "manual review"} | {entry.details}
                  </div>
                </article>
              );
            })}
            {!slaQueue.exceptionHotlist.length ? <div className="meta">No SLA exceptions in hotlist.</div> : null}
          </div>
          <div className="form-row">
            <label>
              Bulk exception note
              <input
                value={bulkExceptionNote}
                onChange={(e) => setBulkExceptionNote(e.target.value)}
                placeholder="Optional note"
              />
            </label>
            <button
              className="primary"
              type="button"
              onClick={runBulkExceptionResolve}
              disabled={bulkActionLoading === "exceptions" || !can("exceptions.resolve")}
            >
              {bulkActionLoading === "exceptions" ? "Applying..." : "Auto-resolve selected exceptions"}
            </button>
          </div>
        </section>

        <section className="form" id="nhf-claims">
          <h3>Claims Workbench</h3>
          <div className="form-row">
            <label>
              Status
              <select
                value={filters.status}
                onChange={(e) => setFilters((current) => ({ ...current, status: e.target.value }))}
              >
                <option value="">All</option>
                <option value="submitted">submitted</option>
                <option value="pending">pending</option>
                <option value="approved">approved</option>
                <option value="rejected">rejected</option>
              </select>
            </label>
            <label>
              Search
              <input
                value={filters.query}
                onChange={(e) => setFilters((current) => ({ ...current, query: e.target.value }))}
                placeholder="Claim ID / patient / order / NHF ID"
              />
            </label>
            <button className="ghost" type="button" onClick={loadClaims}>
              Refresh claims
            </button>
            <button className="ghost" type="button" onClick={exportClaimsCsv} disabled={!can("claims.export")}>
              Export CSV
            </button>
          </div>
          <div className="queue">
            {claims.map((claim) => {
              const draft = claimDraftById[claim.id] || {};
              return (
                <article key={claim.id} className="queue-card">
                  <div className="queue-title">
                    {claim.id} | {claim.status}
                  </div>
                  <div className="queue-meta">
                    Patient: {claim.patientName || claim.patientId} | NHF ID: {claim.patientNhfId || "n/a"}
                  </div>
                  <div className="queue-meta">
                    Prescription: {claim.prescId || "n/a"} | Order: {claim.orderId || "n/a"} | Doctor:{" "}
                    {claim.doctorId || "n/a"} | Pharmacy: {claim.pharmacyId || "n/a"}
                  </div>
                  <div className="form-row">
                    <label>
                      Status
                      <select
                        value={draft.status ?? claim.status}
                        onChange={(e) =>
                          setClaimDraftById((current) => ({
                            ...current,
                            [claim.id]: { ...current[claim.id], status: e.target.value },
                          }))
                        }
                      >
                        <option value="submitted">submitted</option>
                        <option value="pending">pending</option>
                        <option value="approved">approved</option>
                        <option value="rejected">rejected</option>
                      </select>
                    </label>
                    <label>
                      Amount covered
                      <input
                        type="number"
                        value={draft.amountCovered ?? claim.amountCovered ?? 0}
                        onChange={(e) =>
                          setClaimDraftById((current) => ({
                            ...current,
                            [claim.id]: { ...current[claim.id], amountCovered: Number(e.target.value || 0) },
                          }))
                        }
                      />
                    </label>
                    <label>
                      Review note
                      <input
                        value={draft.reviewNote ?? ""}
                        onChange={(e) =>
                          setClaimDraftById((current) => ({
                            ...current,
                            [claim.id]: { ...current[claim.id], reviewNote: e.target.value },
                          }))
                        }
                        placeholder="Optional note"
                      />
                    </label>
                    <button
                      className="primary"
                      type="button"
                      onClick={() => updateClaim(claim)}
                      disabled={!can("claims.update")}
                    >
                      Save
                    </button>
                  </div>
                </article>
              );
            })}
            {!claims.length ? <div className="meta">No NHF claims match this filter.</div> : null}
          </div>
        </section>

        <section className="form" id="nhf-calculator">
          <h3>NHF Calculator</h3>
          <div className="doctor-reminder-grid">
            <label>
              Appointment ID (optional)
              <input
                value={calculatorForm.appointmentId}
                onChange={(e) =>
                  setCalculatorForm((current) => ({ ...current, appointmentId: e.target.value }))
                }
              />
            </label>
            <label>
              Base amount
              <input
                type="number"
                value={calculatorForm.baseAmount}
                onChange={(e) =>
                  setCalculatorForm((current) => ({ ...current, baseAmount: Number(e.target.value || 0) }))
                }
              />
            </label>
            <label>
              Coverage %
              <input
                type="number"
                value={calculatorForm.coveragePercent}
                onChange={(e) =>
                  setCalculatorForm((current) => ({
                    ...current,
                    coveragePercent: Number(e.target.value || 0),
                  }))
                }
              />
            </label>
            <label>
              Coverage cap
              <input
                type="number"
                value={calculatorForm.coverageCap}
                onChange={(e) =>
                  setCalculatorForm((current) => ({ ...current, coverageCap: Number(e.target.value || 0) }))
                }
              />
            </label>
            <label>
              Deductible
              <input
                type="number"
                value={calculatorForm.deductible}
                onChange={(e) =>
                  setCalculatorForm((current) => ({ ...current, deductible: Number(e.target.value || 0) }))
                }
              />
            </label>
            <label>
              Already paid
              <input
                type="number"
                value={calculatorForm.alreadyPaid}
                onChange={(e) =>
                  setCalculatorForm((current) => ({ ...current, alreadyPaid: Number(e.target.value || 0) }))
                }
              />
            </label>
            <label>
              Doctor share %
              <input
                type="number"
                value={calculatorForm.doctorSharePercent}
                onChange={(e) =>
                  setCalculatorForm((current) => ({
                    ...current,
                    doctorSharePercent: Number(e.target.value || 0),
                  }))
                }
              />
            </label>
            <label>
              Pharmacy share %
              <input
                type="number"
                value={calculatorForm.pharmacySharePercent}
                onChange={(e) =>
                  setCalculatorForm((current) => ({
                    ...current,
                    pharmacySharePercent: Number(e.target.value || 0),
                  }))
                }
              />
            </label>
          </div>
          <div className="form-row">
            <button className="primary" type="button" onClick={runCalculator}>
              Run calculator
            </button>
          </div>
          {calculatorResult ? (
            <div className="notice">
              NHF Coverage: JMD {money(calculatorResult.breakdown?.nhfCoverage || 0)} | Patient Co-pay: JMD{" "}
              {money(calculatorResult.breakdown?.patientCopay || 0)} | Remaining Patient Balance: JMD{" "}
              {money(calculatorResult.breakdown?.remainingPatientBalance || 0)} | Doctor Payout: JMD{" "}
              {money(calculatorResult.breakdown?.doctorPayout || 0)} | Pharmacy Payout: JMD{" "}
              {money(calculatorResult.breakdown?.pharmacyPayout || 0)}
            </div>
          ) : null}
        </section>

        <section className="form" id="nhf-payout-summary">
          <h3>Payout Summary</h3>
          <div className="form-row">
            <button className="ghost" type="button" onClick={loadPayouts} disabled={!can("payouts.read")}>
              Refresh payouts
            </button>
            <span className="meta">
              Total doctor NHF deduction: JMD {money(payouts.totals?.doctorNhfDeduction || 0)} | Total
              pharmacy approved claims: JMD {money(payouts.totals?.pharmacyApprovedAmountCovered || 0)}
            </span>
          </div>

          <h4>Doctor Payouts</h4>
          <div className="queue">
            {payouts.doctorPayouts.map((row) => (
              <article key={row.doctorId} className="queue-card">
                <div className="queue-title">{row.doctorName || row.doctorId}</div>
                <div className="queue-meta">
                  Appointments: {row.totalAppointments} | Gross fee: JMD {money(row.grossFee)} | NHF
                  deduction: JMD {money(row.nhfDeduction)}
                </div>
                <div className="queue-meta">
                  Patient paid: JMD {money(row.patientPaid)} | Patient balance: JMD {money(row.patientBalance)}
                </div>
              </article>
            ))}
            {!payouts.doctorPayouts.length ? <div className="meta">No doctor payout rows.</div> : null}
          </div>

          <h4>Pharmacy Payouts</h4>
          <div className="queue">
            {payouts.pharmacyPayouts.map((row) => (
              <article key={row.pharmacyId} className="queue-card">
                <div className="queue-title">{row.pharmacyName || row.pharmacyId}</div>
                <div className="queue-meta">
                  Approved claims: {row.approvedClaims} | Approved amount covered: JMD{" "}
                  {money(row.approvedAmountCovered)}
                </div>
              </article>
            ))}
            {!payouts.pharmacyPayouts.length ? <div className="meta">No pharmacy payout rows.</div> : null}
          </div>
        </section>

        <section className="form" id="nhf-reconciliation">
          <h3>Reconciliation Console</h3>
          <div className="form-row">
            <button className="ghost" type="button" onClick={loadReconciliation}>
              Refresh reconciliation
            </button>
            <span className="meta">
              Total: {reconciliation.summary?.total || 0} | Missing claims:{" "}
              {reconciliation.summary?.missingClaim || 0} | Amount mismatch:{" "}
              {reconciliation.summary?.amountMismatch || 0} | Missing order:{" "}
              {reconciliation.summary?.missingOrder || 0}
            </span>
          </div>
          <div className="queue">
            {reconciliation.rows.map((row, idx) => (
              <article key={`${row.type}-${row.entityId || idx}`} className="queue-card">
                <div className="queue-title">
                  {row.type} | {row.entityType}:{row.entityId}
                </div>
                <div className="queue-meta">
                  Expected: {row.expectedAmount ?? "n/a"} | Actual: {row.actualAmount ?? "n/a"} | Variance:{" "}
                  {row.variance ?? "n/a"}
                </div>
                <div className="queue-meta">{row.reason}</div>
                {renderResolutionHistory(row)}
                <div className="form-row">
                  {row.type === "missing_claim" ? (
                    <button
                      className="ghost"
                      type="button"
                      onClick={() => resolveReconciliationRow(row, "generate_claim_from_appointment")}
                      disabled={resolvingKey === `rec:${row.type}:${row.entityId || row.claimId || "x"}`}
                    >
                      Auto-generate claim
                    </button>
                  ) : null}
                  {row.type === "amount_mismatch" ? (
                    <button
                      className="ghost"
                      type="button"
                      onClick={() => resolveReconciliationRow(row, "sync_claim_to_expected")}
                      disabled={resolvingKey === `rec:${row.type}:${row.entityId || row.claimId || "x"}`}
                    >
                      Sync claim amount
                    </button>
                  ) : null}
                  {row.type === "missing_order" ? (
                    <button
                      className="ghost"
                      type="button"
                      onClick={() => resolveReconciliationRow(row, "reject_claim")}
                      disabled={resolvingKey === `rec:${row.type}:${row.entityId || row.claimId || "x"}`}
                    >
                      Reject claim
                    </button>
                  ) : null}
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => resolveReconciliationRow(row, "create_dispute")}
                    disabled={
                      !can("reconciliation.resolve")
                      || resolvingKey === `rec:${row.type}:${row.entityId || row.claimId || "x"}`
                    }
                  >
                    Create dispute
                  </button>
                </div>
              </article>
            ))}
            {!reconciliation.rows.length ? <div className="meta">No reconciliation issues found.</div> : null}
          </div>
        </section>

        <section className="form" id="nhf-exceptions">
          <h3>Exception Queue</h3>
          <div className="form-row">
            <button className="ghost" type="button" onClick={loadExceptions}>
              Refresh exceptions
            </button>
            <span className="meta">
              Total: {exceptions.summary?.total || 0} | Critical: {exceptions.summary?.critical || 0} | High:{" "}
              {exceptions.summary?.high || 0} | Moderate: {exceptions.summary?.moderate || 0}
            </span>
          </div>
          <div className="queue">
            {exceptions.rows.map((entry, idx) => (
              <article key={`${entry.type}-${entry.claimId || entry.orderId || idx}`} className="queue-card">
                <div className="queue-title">
                  {entry.type} | Severity: {entry.severity}
                </div>
                <div className="queue-meta">
                  Claim: {entry.claimId || "n/a"} | Appointment: {entry.appointmentId || "n/a"} | Order:{" "}
                  {entry.orderId || "n/a"}
                </div>
                <div className="queue-meta">{entry.details}</div>
                {renderResolutionHistory(entry)}
                <div className="form-row">
                  {entry.type === "high_or_invalid_amount" ? (
                    <button
                      className="ghost"
                      type="button"
                      onClick={() => resolveExceptionRow(entry, "cap_to_base_amount")}
                      disabled={
                        !can("exceptions.resolve")
                        || resolvingKey
                          === `exc:${entry.type}:${entry.claimId || entry.orderId || entry.appointmentId || "x"}`
                      }
                    >
                      Cap to base amount
                    </button>
                  ) : null}
                  {entry.type === "missing_patient_nhf_id" ? (
                    <button
                      className="ghost"
                      type="button"
                      onClick={() => resolveExceptionRow(entry, "mark_pending_provider_update")}
                      disabled={
                        !can("exceptions.resolve")
                        || resolvingKey
                          === `exc:${entry.type}:${entry.claimId || entry.orderId || entry.appointmentId || "x"}`
                      }
                    >
                      Mark pending provider update
                    </button>
                  ) : null}
                  {entry.type === "stale_claim" ? (
                    <button
                      className="ghost"
                      type="button"
                      onClick={() => resolveExceptionRow(entry, "escalate_pending_review")}
                      disabled={
                        !can("exceptions.resolve")
                        || resolvingKey
                          === `exc:${entry.type}:${entry.claimId || entry.orderId || entry.appointmentId || "x"}`
                      }
                    >
                      Escalate for review
                    </button>
                  ) : null}
                  {(entry.type === "duplicate_appointment_claims"
                    || entry.type === "duplicate_order_claims") ? (
                    <button
                      className="ghost"
                      type="button"
                      onClick={() => resolveExceptionRow(entry, "keep_latest_reject_others")}
                      disabled={
                        !can("exceptions.resolve")
                        || resolvingKey
                          === `exc:${entry.type}:${entry.claimId || entry.orderId || entry.appointmentId || "x"}`
                      }
                    >
                      Keep latest, reject others
                    </button>
                  ) : null}
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => resolveExceptionRow(entry, "create_dispute")}
                    disabled={
                      !can("exceptions.resolve")
                      || resolvingKey
                        === `exc:${entry.type}:${entry.claimId || entry.orderId || entry.appointmentId || "x"}`
                    }
                  >
                    Create dispute
                  </button>
                </div>
              </article>
            ))}
            {!exceptions.rows.length ? <div className="meta">No exception items.</div> : null}
          </div>
        </section>

        <section className="form" id="nhf-payout-runs">
          <h3>Payout Run Manager</h3>
          <div className="doctor-reminder-grid">
            <label>
              Label
              <input
                value={payoutRunDraft.label}
                onChange={(e) => setPayoutRunDraft((current) => ({ ...current, label: e.target.value }))}
                placeholder="Optional"
              />
            </label>
            <label>
              From
              <input
                type="date"
                value={payoutRunDraft.from}
                onChange={(e) => setPayoutRunDraft((current) => ({ ...current, from: e.target.value }))}
              />
            </label>
            <label>
              To
              <input
                type="date"
                value={payoutRunDraft.to}
                onChange={(e) => setPayoutRunDraft((current) => ({ ...current, to: e.target.value }))}
              />
            </label>
          </div>
          <div className="form-row">
            <button className="primary" type="button" onClick={createPayoutRun} disabled={!can("payouts.runs.create")}>
              Create payout run
            </button>
            <button className="ghost" type="button" onClick={loadPayoutRuns}>
              Refresh payout runs
            </button>
          </div>
          <div className="queue">
            {payoutRuns.map((run) => (
              <article key={run.id} className="queue-card">
                <div className="queue-title">
                  {run.label || "NHF Payout Run"} | {run.status}
                </div>
                <div className="queue-meta">
                  Run ID: {run.id} | Created:{" "}
                  {run.createdAt ? new Date(run.createdAt).toLocaleString() : "n/a"}
                </div>
                <div className="queue-meta">
                  Doctor NHF deduction: JMD {money(run.totals?.doctorNhfDeduction || 0)} | Pharmacy approved: JMD{" "}
                  {money(run.totals?.pharmacyApprovedAmountCovered || 0)}
                </div>
                <div className="form-row">
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => advancePayoutRunStatus(run)}
                    disabled={!can("payouts.runs.transition")}
                  >
                    Advance status
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => exportPayoutRunCsv(run.id)}
                    disabled={!can("payouts.runs.export")}
                  >
                    Export run CSV
                  </button>
                </div>
              </article>
            ))}
            {!payoutRuns.length ? <div className="meta">No payout runs yet.</div> : null}
          </div>
        </section>

        <section className="form" id="nhf-disputes">
          <h3>Dispute Management</h3>
          <div className="doctor-reminder-grid">
            <label>
              Claim ID (optional)
              <input
                value={disputeDraft.claimId}
                onChange={(e) => setDisputeDraft((current) => ({ ...current, claimId: e.target.value }))}
              />
            </label>
            <label>
              Payout Run ID (optional)
              <input
                value={disputeDraft.payoutRunId}
                onChange={(e) => setDisputeDraft((current) => ({ ...current, payoutRunId: e.target.value }))}
              />
            </label>
            <label>
              Reason
              <input
                value={disputeDraft.reason}
                onChange={(e) => setDisputeDraft((current) => ({ ...current, reason: e.target.value }))}
                placeholder="Required"
              />
            </label>
            <label>
              Notes
              <input
                value={disputeDraft.notes}
                onChange={(e) => setDisputeDraft((current) => ({ ...current, notes: e.target.value }))}
              />
            </label>
          </div>
          <div className="form-row">
            <button className="primary" type="button" onClick={createDispute} disabled={!can("disputes.create")}>
              Create dispute
            </button>
            <button className="ghost" type="button" onClick={loadDisputes}>
              Refresh disputes
            </button>
          </div>
          <div className="queue">
            {disputes.map((entry) => (
              <article key={entry.id} className="queue-card">
                <div className="queue-title">
                  {entry.id} | {entry.status}
                </div>
                <div className="queue-meta">
                  Claim: {entry.claimId || "n/a"} | Payout run: {entry.payoutRunId || "n/a"} | Assignee:{" "}
                  {entry.assigneeId || "n/a"}
                </div>
                <div className="queue-meta">{entry.reason}</div>
                <div className="form-row">
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => updateDisputeStatus(entry, "in_review")}
                    disabled={!can("disputes.update")}
                  >
                    In review
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => updateDisputeStatus(entry, "resolved")}
                    disabled={!can("disputes.update")}
                  >
                    Resolve
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => updateDisputeStatus(entry, "rejected")}
                    disabled={!can("disputes.update")}
                  >
                    Reject
                  </button>
                </div>
              </article>
            ))}
            {!disputes.length ? <div className="meta">No disputes yet.</div> : null}
          </div>
        </section>

            {message ? <p className="notice">{message}</p> : null}
            {error ? <p className="notice error">{error}</p> : null}
          </main>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>NHF Claims</h2>
      <div className="form">
        <label>
          Prescription ID
          <input value={prescId} onChange={(e) => setPrescId(e.target.value)} />
        </label>
        <label>
          Order ID
          <input value={orderId} onChange={(e) => setOrderId(e.target.value)} />
        </label>
        <label>
          NHF ID
          <input value={patientNhfId} onChange={(e) => setPatientNhfId(e.target.value)} />
        </label>
        <label>
          Amount covered
          <input type="number" value={amountCovered} onChange={(e) => setAmountCovered(e.target.value)} />
        </label>
        <button className="primary" onClick={submitPatientClaim}>
          Submit NHF claim
        </button>
      </div>
      <GlobalFeedbackOverlay
        successMessage={message}
        errorMessage={error}
        onClose={() => {
          setMessage("");
          setError("");
        }}
      />
    </section>
  );
}
