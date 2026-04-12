import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { apiFetch } from "../utils/api.js";
import GlobalFeedbackOverlay from "../components/GlobalFeedbackOverlay.jsx";

const FILTER_PRESET_KEY = "refillit_moh_registry_filters";
const OPS_CHECKLIST_KEY = "refillit_moh_ops_checklist";
const ESCALATION_CASES_KEY = "refillit_moh_escalation_cases";
const PAGE_SIZE = 8;
const REJECTION_REASON_OPTIONS = [
  { code: "INCOMPLETE_FIELDS", label: "Incomplete required fields" },
  { code: "SIGNATURE_MISMATCH", label: "Signature mismatch / invalid signer" },
  { code: "CHAIN_BREAK", label: "Chain-of-custody break" },
  { code: "DATA_INCONSISTENT", label: "Data inconsistent with order/prescription" },
  { code: "MISSING_SUBMISSION_NOTE", label: "Missing submission note" },
  { code: "OTHER", label: "Other" },
];

export default function MohReports() {
  const { apiBase, token, user, role } = useAuth();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [report, setReport] = useState(null);
  const [snapshotId, setSnapshotId] = useState("");
  const [validation, setValidation] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [loadingSubmissions, setLoadingSubmissions] = useState(false);
  const [decisionNotesById, setDecisionNotesById] = useState({});
  const [decidingById, setDecidingById] = useState({});
  const [queueView, setQueueView] = useState("all");
  const [registryStatus, setRegistryStatus] = useState("all");
  const [registryPharmacy, setRegistryPharmacy] = useState("");
  const [registrySearch, setRegistrySearch] = useState("");
  const [registryFrom, setRegistryFrom] = useState("");
  const [registryTo, setRegistryTo] = useState("");
  const [page, setPage] = useState(1);
  const [exportFormat, setExportFormat] = useState("csv");
  const [creatingExportJob, setCreatingExportJob] = useState(false);
  const [exportJobs, setExportJobs] = useState([]);
  const [loadingExportJobs, setLoadingExportJobs] = useState(false);
  const [exportJobsTotal, setExportJobsTotal] = useState(0);
  const [exportJobSearch, setExportJobSearch] = useState("");
  const [downloadingJobId, setDownloadingJobId] = useState("");
  const [approvalReasonByJobId, setApprovalReasonByJobId] = useState({});
  const [decidingExportJobById, setDecidingExportJobById] = useState({});
  const [unlockModalJob, setUnlockModalJob] = useState(null);
  const [unlockReason, setUnlockReason] = useState("");
  const [unlockingJobId, setUnlockingJobId] = useState("");
  const [selectedPharmacyTrend, setSelectedPharmacyTrend] = useState("");
  const [selectedReviewDoctorId, setSelectedReviewDoctorId] = useState("");
  const [opsChecklist, setOpsChecklist] = useState({
    intakeSweep: false,
    riskTriage: false,
    decisionBlock: false,
    exportControl: false,
    exceptionHandling: false,
  });
  const [escalationCases, setEscalationCases] = useState([]);
  const [reviewChecklistById, setReviewChecklistById] = useState({});
  const [structuredRejectionById, setStructuredRejectionById] = useState({});
  const [highRiskById, setHighRiskById] = useState({});
  const [policyById, setPolicyById] = useState({});
  const [policyOptions, setPolicyOptions] = useState([]);
  const [activeSection, setActiveSection] = useState("moh-overview");
  const [error, setError] = useState("");
  const [resolverQuery, setResolverQuery] = useState("");
  const [resolverResults, setResolverResults] = useState([]);
  const [resolverLoading, setResolverLoading] = useState(false);
  const [resolverError, setResolverError] = useState("");
  const [resolverOpen, setResolverOpen] = useState(false);
  const [evidenceModal, setEvidenceModal] = useState({ open: false, snapshotId: "", files: [] });
  const [snapshotModal, setSnapshotModal] = useState({ open: false, entry: null });
  const [actionNotice, setActionNotice] = useState("");
  const [recentApprovalById, setRecentApprovalById] = useState({});
  const mohRole = user?.mohRole || (role === "admin" ? "supervisor" : "analyst");
  const mohPermissions = useMemo(
    () => ({
      canApprove: mohRole === "supervisor",
      canCreateExport: mohRole === "supervisor",
      canApproveExport: mohRole === "supervisor",
      canUnlockExport: mohRole === "supervisor",
      canDownloadExport: mohRole === "supervisor" || mohRole === "auditor",
    }),
    [mohRole]
  );

  const normalizeSnapshotId = (rawValue) => {
    const raw = String(rawValue || "").trim();
    if (!raw) return "";
    return raw.split("|")[0].trim();
  };

  const toCsv = (rows) => {
    const escape = (value) => {
      const raw = String(value ?? "");
      if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
      return raw;
    };
    return rows.map((row) => row.map(escape).join(",")).join("\n");
  };

  const generate = async () => {
    try {
      setError("");
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/moh/reports",
        method: "POST",
        body: { from, to },
      });
      setReport(data);
    } catch (err) {
      setError(err.message);
    }
  };

  const validateSnapshot = async () => {
    const id = normalizeSnapshotId(snapshotId);
    if (!id) {
      setError("Enter a compliance snapshot ID.");
      return;
    }
    try {
      setError("");
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/moh/compliance-snapshots/${encodeURIComponent(id)}/validate`,
      });
      setValidation(data);
    } catch (err) {
      setError(err.message);
    }
  };

  const validateSnapshotById = async (snapshotIdToValidate) => {
    try {
      const id = normalizeSnapshotId(snapshotIdToValidate);
      if (!id) {
        setError("Invalid snapshot ID.");
        return;
      }
      setSnapshotId(id);
      setError("");
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/moh/compliance-snapshots/${encodeURIComponent(id)}/validate`,
      });
      setValidation(data);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadSubmissions = async () => {
    try {
      setLoadingSubmissions(true);
      setError("");
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/moh/compliance-snapshot-submissions",
      });
      const rows = data.submissions || [];
      setSubmissions(rows);
      setReviewChecklistById((current) => {
        const next = { ...current };
        for (const entry of rows) {
          if (entry.reviewChecklist) next[entry.id] = entry.reviewChecklist;
        }
        return next;
      });
      setStructuredRejectionById((current) => {
        const next = { ...current };
        for (const entry of rows) {
          if (entry.structuredRejection) next[entry.id] = entry.structuredRejection;
        }
        return next;
      });
      setHighRiskById((current) => {
        const next = { ...current };
        for (const entry of rows) {
          if (entry.highRisk) next[entry.id] = entry.highRisk;
        }
        return next;
      });
      setPolicyById((current) => {
        const next = { ...current };
        for (const entry of rows) {
          if (entry.policyVersion) next[entry.id] = entry.policyVersion;
        }
        return next;
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingSubmissions(false);
    }
  };

  const loadPolicies = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/moh/policies",
      });
      const options = (data.policies || []).map((policy) => ({
        code: policy.code,
        label: `${policy.code} â€” ${policy.name}`,
      }));
      setPolicyOptions(options);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadExportJobs = async () => {
    try {
      setLoadingExportJobs(true);
      setError("");
      const query = new URLSearchParams();
      query.set("limit", "20");
      if (exportJobSearch.trim()) query.set("search", exportJobSearch.trim());
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/moh/export-jobs?${query.toString()}`,
      });
      setExportJobs(data.jobs || []);
      setExportJobsTotal(Number(data.total || 0));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingExportJobs(false);
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
        path: `/api/moh/id-resolve?query=${encodeURIComponent(query)}`,
      });
      setResolverResults(data.results || []);
    } catch (err) {
      setResolverError(err.message);
      setResolverResults([]);
    } finally {
      setResolverLoading(false);
    }
  };

  const decideSubmission = async (snapshotIdToDecide, decision) => {
    if (!mohPermissions.canApprove) {
      setError("Approval requires MOH supervisor role.");
      return;
    }
    try {
      setError("");
      setActionNotice("");
      setDecidingById((current) => ({ ...current, [snapshotIdToDecide]: decision }));
      const entry = submissions.find((item) => item.id === snapshotIdToDecide);
      const reviewChecklist = reviewChecklistById[snapshotIdToDecide] || {};
      if (decision === "approved") {
        const allChecked = ["integrity", "signature", "notes"].every((key) => reviewChecklist[key]);
        if (!allChecked) {
          setError("Complete the review checklist before approving.");
          setDecidingById((current) => {
            const next = { ...current };
            delete next[snapshotIdToDecide];
            return next;
          });
          return;
        }
      }
      if (entry?.schemaValidation && entry.schemaValidation.isValid === false) {
        setError("Schema validation failed. Resolve missing fields before approving/rejecting.");
        setDecidingById((current) => {
          const next = { ...current };
          delete next[snapshotIdToDecide];
          return next;
        });
        return;
      }
      if (entry?.riskLevel === "high") {
        const highRisk = highRiskById[snapshotIdToDecide] || {};
        if (!String(highRisk.reasonCode || "").trim() || !String(highRisk.actionPlan || "").trim()) {
          setError("High-risk snapshots require reason code + corrective action plan before decision.");
          setDecidingById((current) => {
            const next = { ...current };
            delete next[snapshotIdToDecide];
            return next;
          });
          return;
        }
      }
      const policyVersion = String(policyById[snapshotIdToDecide] || "").trim();
      if (!policyVersion) {
        setError("Select a policy version before approving/rejecting.");
        setDecidingById((current) => {
          const next = { ...current };
          delete next[snapshotIdToDecide];
          return next;
        });
        return;
      }
      let note = (decisionNotesById[snapshotIdToDecide] || "").trim();
      if (decision === "rejected") {
        const structured = structuredRejectionById[snapshotIdToDecide] || {};
        const selectedCode = structured.code || "";
        if (!selectedCode) {
          setError("Select a structured rejection reason before rejecting.");
          setDecidingById((current) => {
            const next = { ...current };
            delete next[snapshotIdToDecide];
            return next;
          });
          return;
        }
        const reasonText = structured.note ? ` (${structured.note})` : "";
        note = `[${selectedCode}] ${REJECTION_REASON_OPTIONS.find((item) => item.code === selectedCode)?.label || "Other"}${reasonText}`;
      }
      await apiFetch({
        apiBase,
        token,
        path: `/api/moh/compliance-snapshot-submissions/${encodeURIComponent(snapshotIdToDecide)}/decision`,
        method: "POST",
        body: {
          decision,
          note,
          reviewChecklist: reviewChecklistById[snapshotIdToDecide] || null,
          structuredRejection: structuredRejectionById[snapshotIdToDecide] || null,
          highRisk: highRiskById[snapshotIdToDecide] || null,
          policyVersion,
        },
      });
      setSubmissions((current) =>
        current.map((entry) =>
          entry.id === snapshotIdToDecide
            ? {
                ...entry,
                status: decision,
                reviewDecision: decision,
                reviewedBy: user?.id || entry.reviewedBy,
                reviewedAt: new Date().toISOString(),
                reviewNote: note || entry.reviewNote || null,
              }
            : entry
        )
      );
      if (decision === "approved") {
        setRecentApprovalById((current) => ({ ...current, [snapshotIdToDecide]: Date.now() }));
        window.setTimeout(() => {
          setRecentApprovalById((current) => {
            const next = { ...current };
            delete next[snapshotIdToDecide];
            return next;
          });
        }, 12000);
      }
      setActionNotice(
        `Snapshot ${snapshotIdToDecide} ${decision}. If it disappears, switch queue filter to "${decision}".`
      );
      await loadSubmissions();
    } catch (err) {
      setError(err.message);
    } finally {
      setDecidingById((current) => {
        const next = { ...current };
        delete next[snapshotIdToDecide];
        return next;
      });
    }
  };

  const createExportJob = async () => {
    try {
      setCreatingExportJob(true);
      setError("");
      const exportSearch = [registrySearch.trim(), selectedReviewDoctorId.trim()].filter(Boolean).join(" ");
      await apiFetch({
        apiBase,
        token,
        path: "/api/moh/export-jobs",
        method: "POST",
        body: {
          scope: "compliance_snapshot_submissions",
          format: exportFormat,
          filters: {
            queueView,
            status: registryStatus,
            pharmacyId: registryPharmacy,
            search: exportSearch,
            from: registryFrom,
            to: registryTo,
          },
        },
      });
      await loadExportJobs();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreatingExportJob(false);
    }
  };

  const downloadExportJob = async (job) => {
    try {
      setDownloadingJobId(job.id);
      setError("");
      const response = await fetch(`${apiBase}/api/moh/export-jobs/${encodeURIComponent(job.id)}/download`, {
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
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = job.fileName || `moh-export-${job.id}.${job.format === "csv" ? "csv" : "html"}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloadingJobId("");
    }
  };

  const decideExportJob = async (job, decision) => {
    try {
      const reason = String(approvalReasonByJobId[job.id] || "").trim();
      if (!reason) {
        setError("Approval reason is required before approve/reject.");
        return;
      }
      setDecidingExportJobById((current) => ({ ...current, [job.id]: decision }));
      setError("");
      await apiFetch({
        apiBase,
        token,
        path: `/api/moh/export-jobs/${encodeURIComponent(job.id)}/approval`,
        method: "POST",
        body: {
          decision,
          reason,
          lock: true,
        },
      });
      await loadExportJobs();
    } catch (err) {
      setError(err.message);
    } finally {
      setDecidingExportJobById((current) => {
        const next = { ...current };
        delete next[job.id];
        return next;
      });
    }
  };

  const openUnlockModal = (job) => {
    setUnlockModalJob(job);
    setUnlockReason("");
    setError("");
  };

  const closeUnlockModal = () => {
    setUnlockModalJob(null);
    setUnlockReason("");
  };

  const unlockExportJob = async () => {
    if (!unlockModalJob) return;
    const reason = String(unlockReason || "").trim();
    if (!reason) {
      setError("Second-review reason is required to unlock this export job.");
      return;
    }
    try {
      setUnlockingJobId(unlockModalJob.id);
      setError("");
      await apiFetch({
        apiBase,
        token,
        path: `/api/moh/export-jobs/${encodeURIComponent(unlockModalJob.id)}/unlock`,
        method: "POST",
        body: { reason },
      });
      closeUnlockModal();
      await loadExportJobs();
    } catch (err) {
      setError(err.message);
    } finally {
      setUnlockingJobId("");
    }
  };

  const saveRegistryPreset = () => {
    const payload = {
      queueView,
      registryStatus,
      registryPharmacy,
      selectedReviewDoctorId,
      registrySearch,
      registryFrom,
      registryTo,
    };
    localStorage.setItem(FILTER_PRESET_KEY, JSON.stringify(payload));
  };

  const loadRegistryPreset = () => {
    try {
      const raw = localStorage.getItem(FILTER_PRESET_KEY);
      if (!raw) return;
      const preset = JSON.parse(raw);
      setQueueView(preset.queueView || "all");
      setRegistryStatus(preset.registryStatus || "all");
      setRegistryPharmacy(preset.registryPharmacy || "");
      setSelectedReviewDoctorId(preset.selectedReviewDoctorId || "");
      setRegistrySearch(preset.registrySearch || "");
      setRegistryFrom(preset.registryFrom || "");
      setRegistryTo(preset.registryTo || "");
    } catch (_err) {
      // ignore malformed preset
    }
  };

  const registrySummary = useMemo(() => {
    const summary = {
      total: submissions.length,
      submitted: 0,
      approved: 0,
      rejected: 0,
      newQueue: 0,
      overdue: 0,
    };
    const nowMs = Date.now();
    for (const entry of submissions) {
      const status = String(entry.status || "").toLowerCase();
      if (status === "submitted") summary.submitted += 1;
      if (status === "approved") summary.approved += 1;
      if (status === "rejected") summary.rejected += 1;
      if (status === "submitted") {
        const ageHours = (nowMs - new Date(entry.submittedAt || 0).getTime()) / 3600000;
        if (ageHours < 24) summary.newQueue += 1;
        if (ageHours >= 24) summary.overdue += 1;
      }
    }
    return summary;
  }, [submissions]);

  const riskDashboard = useMemo(() => {
    const highRisk = submissions.filter((entry) => {
      const status = String(entry.status || "").toLowerCase();
      if (status !== "submitted") return false;
      return String(entry.riskLevel || "").toLowerCase() === "high";
    }).length;
    const reviewRate = submissions.length
      ? Math.round(((registrySummary.approved + registrySummary.rejected) / submissions.length) * 100)
      : 0;
    return {
      total: registrySummary.total,
      pending: registrySummary.submitted,
      overdue: registrySummary.overdue,
      highRisk,
      reviewRate,
    };
  }, [submissions, registrySummary]);

  const rejectionReasonOptions = [
    { code: "INCOMPLETE_FIELDS", label: "Incomplete required fields" },
    { code: "SIGNATURE_MISMATCH", label: "Signature mismatch / invalid signer" },
    { code: "CHAIN_BREAK", label: "Chain-of-custody break" },
    { code: "DATA_INCONSISTENT", label: "Data inconsistent with order/prescription" },
    { code: "MISSING_SUBMISSION_NOTE", label: "Missing submission note" },
    { code: "OTHER", label: "Other" },
  ];
  const computeCompleteness = (entry) => {
    const required = [
      { label: "Snapshot ID", value: entry.id },
      { label: "Pharmacy ID", value: entry.pharmacyId },
      { label: "Submitted at", value: entry.submittedAt },
      { label: "Submitted by", value: entry.submittedBy },
      { label: "Signed by", value: entry.signedBy },
      { label: "Signed at", value: entry.signedAt },
      { label: "Submission note", value: entry.submissionNote },
    ];
    const missing = required.filter((item) => !String(item.value || "").trim());
    const score = Math.round(((required.length - missing.length) / required.length) * 100);
    return { score, missing };
  };

  const reviewSla = useMemo(() => {
    const durations = submissions
      .filter((entry) => ["approved", "rejected"].includes(String(entry.status || "").toLowerCase()))
      .map((entry) => {
        const submittedMs = new Date(entry.submittedAt || 0).getTime();
        const reviewedMs = new Date(entry.reviewedAt || 0).getTime();
        if (!Number.isFinite(submittedMs) || !Number.isFinite(reviewedMs)) return null;
        const hours = (reviewedMs - submittedMs) / 3600000;
        return Number.isFinite(hours) && hours >= 0 ? hours : null;
      })
      .filter((value) => typeof value === "number")
      .sort((a, b) => a - b);

    const pickPercentile = (pct) => {
      if (!durations.length) return 0;
      const index = Math.min(durations.length - 1, Math.ceil((pct / 100) * durations.length) - 1);
      return durations[index];
    };

    return {
      median: pickPercentile(50),
      p90: pickPercentile(90),
      reviewedCount: durations.length,
    };
  }, [submissions]);

  const overdueBacklog = useMemo(() => {
    const nowMs = Date.now();
    let over24 = 0;
    let over48 = 0;
    submissions.forEach((entry) => {
      const status = String(entry.status || "").toLowerCase();
      if (status !== "submitted") return;
      const submittedMs = new Date(entry.submittedAt || 0).getTime();
      if (!Number.isFinite(submittedMs)) return;
      const ageHours = (nowMs - submittedMs) / 3600000;
      if (ageHours >= 24) over24 += 1;
      if (ageHours >= 48) over48 += 1;
    });
    return { over24, over48 };
  }, [submissions]);

  const schemaCompleteness = useMemo(() => {
    if (!submissions.length) return { avgScore: 0, fullyComplete: 0 };
    let scoreSum = 0;
    let completeCount = 0;
    submissions.forEach((entry) => {
      const completeness = computeCompleteness(entry);
      scoreSum += completeness.score;
      if (completeness.score === 100) completeCount += 1;
    });
    return {
      avgScore: Math.round(scoreSum / submissions.length),
      fullyComplete: completeCount,
    };
  }, [submissions]);

  const rejectionMix = useMemo(() => {
    const counts = new Map();
    submissions.forEach((entry) => {
      const status = String(entry.status || "").toLowerCase();
      if (status !== "rejected") return;
      const structured = entry.structuredRejection || {};
      const code = String(structured.code || "").trim() || "OTHER";
      counts.set(code, (counts.get(code) || 0) + 1);
    });
    const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
    const labelMap = REJECTION_REASON_OPTIONS.reduce((acc, item) => {
      acc[item.code] = item.label;
      return acc;
    }, {});
    return Array.from(counts.entries())
      .map(([code, count]) => ({
        code,
        label: labelMap[code] || "Other",
        count,
        pct: total ? Math.round((count / total) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [submissions]);

  const policyAdoption = useMemo(() => {
    const latestPolicy = policyOptions[0]?.code || "";
    if (!latestPolicy) return { latestPolicy: "", pct: 0 };
    const reviewed = submissions.filter((entry) =>
      ["approved", "rejected"].includes(String(entry.status || "").toLowerCase())
    );
    const compliant = reviewed.filter((entry) => String(entry.policyVersion || "") === latestPolicy);
    return {
      latestPolicy,
      pct: reviewed.length ? Math.round((compliant.length / reviewed.length) * 100) : 0,
    };
  }, [submissions, policyOptions]);

  const reviewerLeaderboard = useMemo(() => {
    const map = new Map();
    submissions.forEach((entry) => {
      if (!entry.reviewedBy) return;
      const reviewer = String(entry.reviewedBy || "").trim();
      if (!reviewer) return;
      if (!map.has(reviewer)) {
        map.set(reviewer, { reviewer, reviewed: 0, avgHours: 0, totalHours: 0 });
      }
      const row = map.get(reviewer);
      row.reviewed += 1;
      const submittedMs = new Date(entry.submittedAt || 0).getTime();
      const reviewedMs = new Date(entry.reviewedAt || 0).getTime();
      if (Number.isFinite(submittedMs) && Number.isFinite(reviewedMs) && reviewedMs >= submittedMs) {
        row.totalHours += (reviewedMs - submittedMs) / 3600000;
      }
    });
    return Array.from(map.values())
      .map((row) => ({
        ...row,
        avgHours: row.reviewed ? row.totalHours / row.reviewed : 0,
      }))
      .sort((a, b) => b.reviewed - a.reviewed)
      .slice(0, 6);
  }, [submissions]);

  const weeklySla = useMemo(() => {
    const now = new Date();
    const buckets = [];
    for (let i = 5; i >= 0; i -= 1) {
      const weekStart = new Date(now);
      weekStart.setHours(0, 0, 0, 0);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay() - i * 7);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      buckets.push({
        key: weekStart.toISOString().slice(0, 10),
        label: weekStart.toISOString().slice(5, 10),
        reviewed: 0,
        within24: 0,
      });
    }
    submissions.forEach((entry) => {
      if (!entry.reviewedAt || !entry.submittedAt) return;
      const reviewedAt = new Date(entry.reviewedAt);
      const submittedAt = new Date(entry.submittedAt);
      const bucket = buckets.find(
        (row) => reviewedAt >= new Date(row.key) && reviewedAt < new Date(new Date(row.key).getTime() + 7 * 86400000)
      );
      if (!bucket) return;
      bucket.reviewed += 1;
      const hours = (reviewedAt.getTime() - submittedAt.getTime()) / 3600000;
      if (hours <= 24) bucket.within24 += 1;
    });
    return buckets.map((row) => ({
      ...row,
      pct: row.reviewed ? Math.round((row.within24 / row.reviewed) * 100) : 0,
    }));
  }, [submissions]);

  const exportMohAnalyticsCsv = () => {
    const rows = [
      ["# MOH analytics snapshot export"],
      ["metric", "value"],
      ["review_sla_median_hours", reviewSla.median.toFixed(2)],
      ["review_sla_p90_hours", reviewSla.p90.toFixed(2)],
      ["overdue_24h", overdueBacklog.over24],
      ["overdue_48h", overdueBacklog.over48],
      ["schema_completeness_avg", schemaCompleteness.avgScore],
      ["schema_fully_complete_count", schemaCompleteness.fullyComplete],
      ["policy_latest_code", policyAdoption.latestPolicy || "n/a"],
      ["policy_latest_adoption_pct", policyAdoption.pct],
      ["selected_pharmacy", selectedPharmacyTrend || "all"],
      ["selected_pharmacy_overdue", pharmacyRiskKpi.overdue],
      ["selected_pharmacy_review_rate", pharmacyRiskKpi.reviewRate],
      ["selected_pharmacy_trend_delta", pharmacyRiskKpi.trendDelta],
    ];
    rows.push([]);
    rows.push(["reviewer_leaderboard"]);
    rows.push(["reviewer", "reviewed_count", "avg_review_hours"]);
    reviewerLeaderboard.forEach((row) => {
      rows.push([row.reviewer, row.reviewed, row.avgHours.toFixed(2)]);
    });
    rows.push([]);
    rows.push(["weekly_sla"]);
    rows.push(["week_start", "reviewed", "within_24h_pct"]);
    weeklySla.forEach((row) => {
      rows.push([row.key, row.reviewed, row.pct]);
    });
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `moh-analytics-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const trendRows = useMemo(() => {
    const days = 14;
    const bucket = new Map();
    const order = [];
    for (let index = days - 1; index >= 0; index -= 1) {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - index);
      const key = date.toISOString().slice(0, 10);
      order.push(key);
      bucket.set(key, { key, label: key.slice(5), submitted: 0, approved: 0, rejected: 0, total: 0 });
    }
    for (const entry of submissions) {
      const key = String(entry.submittedAt || "").slice(0, 10);
      if (!bucket.has(key)) continue;
      const row = bucket.get(key);
      row.total += 1;
      const status = String(entry.status || "").toLowerCase();
      if (status === "approved") row.approved += 1;
      else if (status === "rejected") row.rejected += 1;
      else row.submitted += 1;
    }
    return order.map((key) => bucket.get(key));
  }, [submissions]);

  const maxTrendTotal = useMemo(() => Math.max(1, ...trendRows.map((row) => row.total || 0)), [trendRows]);

  const pharmacyOversightRows = useMemo(() => {
    const nowMs = Date.now();
    const grouped = new Map();
    for (const entry of submissions) {
      const pharmacyId = String(entry.pharmacyId || "unassigned");
      if (!grouped.has(pharmacyId)) {
        grouped.set(pharmacyId, {
          pharmacyId,
          total: 0,
          submitted: 0,
          approved: 0,
          rejected: 0,
          overdue: 0,
        });
      }
      const row = grouped.get(pharmacyId);
      row.total += 1;
      const status = String(entry.status || "").toLowerCase();
      if (status === "submitted") {
        row.submitted += 1;
        const ageHours = (nowMs - new Date(entry.submittedAt || 0).getTime()) / 3600000;
        if (Number.isFinite(ageHours) && ageHours >= 24) row.overdue += 1;
      } else if (status === "approved") {
        row.approved += 1;
      } else if (status === "rejected") {
        row.rejected += 1;
      }
    }
    return Array.from(grouped.values())
      .map((row) => {
        const reviewed = row.approved + row.rejected;
        const reviewRate = row.total ? Math.round((reviewed / row.total) * 100) : 0;
        return {
          ...row,
          reviewRate,
          riskLevel: row.overdue >= 3 || row.reviewRate < 40 ? "high" : row.overdue >= 1 || row.reviewRate < 70 ? "medium" : "low",
        };
      })
      .sort((a, b) => {
        if (b.overdue !== a.overdue) return b.overdue - a.overdue;
        if (a.reviewRate !== b.reviewRate) return a.reviewRate - b.reviewRate;
        return a.pharmacyId.localeCompare(b.pharmacyId);
      });
  }, [submissions]);

  const reviewSelectorOptions = useMemo(() => {
    const pharmacyIds = Array.from(
      new Set(
        submissions
          .map((entry) => String(entry.pharmacyId || "").trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));

    const doctorOrReviewerIds = Array.from(
      new Set(
        submissions
          .flatMap((entry) => [entry.signedBy, entry.submittedBy, entry.reviewedBy])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));

    return { pharmacyIds, doctorOrReviewerIds };
  }, [submissions]);

  const highRiskReasonOptions = [
    { code: "CRITICAL_SAFETY", label: "Critical safety violation" },
    { code: "CHAIN_BREAK", label: "Chain-of-custody break" },
    { code: "FRAUD_RISK", label: "Potential fraud/forgery risk" },
    { code: "CONTROLLED_SUBSTANCE", label: "Controlled substance discrepancy" },
    { code: "OTHER", label: "Other" },
  ];

  const selectedPharmacyTrendRows = useMemo(() => {
    const days = 14;
    const bucket = new Map();
    const order = [];
    for (let index = days - 1; index >= 0; index -= 1) {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - index);
      const key = date.toISOString().slice(0, 10);
      order.push(key);
      bucket.set(key, { key, label: key.slice(5), submitted: 0, approved: 0, rejected: 0, total: 0 });
    }

    const pharmacyId = String(selectedPharmacyTrend || "").trim().toLowerCase();
    for (const entry of submissions) {
      if (!pharmacyId) continue;
      if (String(entry.pharmacyId || "").trim().toLowerCase() !== pharmacyId) continue;
      const key = String(entry.submittedAt || "").slice(0, 10);
      if (!bucket.has(key)) continue;
      const row = bucket.get(key);
      row.total += 1;
      const status = String(entry.status || "").toLowerCase();
      if (status === "approved") row.approved += 1;
      else if (status === "rejected") row.rejected += 1;
      else row.submitted += 1;
    }
    return order.map((key) => bucket.get(key));
  }, [submissions, selectedPharmacyTrend]);

  const selectedPharmacyMaxTrendTotal = useMemo(
    () => Math.max(1, ...selectedPharmacyTrendRows.map((row) => row.total || 0)),
    [selectedPharmacyTrendRows]
  );

  const pharmacyRiskKpi = useMemo(() => {
    if (!selectedPharmacyTrend) return { overdue: 0, reviewRate: 0, trendDelta: 0 };
    const selected = pharmacyOversightRows.find((row) => row.pharmacyId === selectedPharmacyTrend);
    const currentRate = selected?.reviewRate || 0;
    const trend = selectedPharmacyTrendRows.map((row) => {
      const reviewed = row.approved + row.rejected;
      return reviewed ? Math.round((reviewed / row.total) * 100) : 0;
    });
    const delta = trend.length >= 2 ? trend[trend.length - 1] - trend[trend.length - 2] : 0;
    return {
      overdue: selected?.overdue || 0,
      reviewRate: currentRate,
      trendDelta: delta,
    };
  }, [selectedPharmacyTrend, pharmacyOversightRows, selectedPharmacyTrendRows]);

  const escalationItems = useMemo(() => {
    const highRiskPharmacies = pharmacyOversightRows.filter((row) => row.riskLevel === "high").length;
    const lowReviewPharmacies = pharmacyOversightRows.filter((row) => row.reviewRate < 70).length;
    const items = [];
    if (registrySummary.overdue > 0) {
      items.push({
        id: "overdue-queue",
        severity: registrySummary.overdue >= 3 ? "high" : "medium",
        title: "Overdue queue requires action",
        detail: `${registrySummary.overdue} submission(s) are pending for 24h or more.`,
        onClick: () => {
          setQueueView("overdue");
          setRegistryStatus("submitted");
        },
      });
    }
    if (highRiskPharmacies > 0) {
      items.push({
        id: "high-risk-pharmacy",
        severity: "high",
        title: "High-risk pharmacies detected",
        detail: `${highRiskPharmacies} pharmacy account(s) exceed risk thresholds.`,
        onClick: () => setQueueView("overdue"),
      });
    }
    if (riskDashboard.reviewRate < 70) {
      items.push({
        id: "review-rate",
        severity: riskDashboard.reviewRate < 40 ? "high" : "medium",
        title: "Review completion below target",
        detail: `Current completion is ${riskDashboard.reviewRate}% (target >= 90%).`,
        onClick: () => setRegistryStatus("submitted"),
      });
    }
    if (!items.length) {
      items.push({
        id: "all-clear",
        severity: "low",
        title: "No active escalation triggers",
        detail: "All monitored thresholds are currently within target.",
        onClick: null,
      });
    }
    return {
      items,
      highRiskPharmacies,
      lowReviewPharmacies,
    };
  }, [pharmacyOversightRows, registrySummary.overdue, riskDashboard.reviewRate]);

  const governanceSummary = useMemo(() => {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - 6);
    const weekStartMs = weekStart.getTime();

    const weekly = submissions.filter((entry) => {
      const submittedMs = new Date(entry.submittedAt || 0).getTime();
      return Number.isFinite(submittedMs) && submittedMs >= weekStartMs;
    });

    let overdue = 0;
    let reviewedWithin24h = 0;
    let reviewedTotal = 0;
    let submittedTotal = 0;
    for (const entry of weekly) {
      const status = String(entry.status || "").toLowerCase();
      const submittedAtMs = new Date(entry.submittedAt || 0).getTime();
      if (!Number.isFinite(submittedAtMs)) continue;
      submittedTotal += 1;
      if (status === "submitted") {
        const ageHours = (Date.now() - submittedAtMs) / 3600000;
        if (ageHours >= 24) overdue += 1;
      } else if (status === "approved" || status === "rejected") {
        reviewedTotal += 1;
        const reviewedAtMs = new Date(entry.reviewedAt || 0).getTime();
        if (Number.isFinite(reviewedAtMs)) {
          const reviewHours = (reviewedAtMs - submittedAtMs) / 3600000;
          if (reviewHours <= 24) reviewedWithin24h += 1;
        }
      }
    }

    const reviewedWithin24hRate = reviewedTotal ? Math.round((reviewedWithin24h / reviewedTotal) * 100) : 0;
    const overdueRate = submittedTotal ? Number(((overdue / submittedTotal) * 100).toFixed(1)) : 0;

    const targetReviewedWithin24h = 90;
    const targetOverdueRateMax = 5;
    const reviewedTargetPass = reviewedWithin24hRate >= targetReviewedWithin24h;
    const overdueTargetPass = overdueRate <= targetOverdueRateMax;

    return {
      weekStart: weekStart.toISOString().slice(0, 10),
      weekEnd: now.toISOString().slice(0, 10),
      submittedTotal,
      reviewedTotal,
      reviewedWithin24h,
      reviewedWithin24hRate,
      overdue,
      overdueRate,
      targetReviewedWithin24h,
      targetOverdueRateMax,
      reviewedTargetPass,
      overdueTargetPass,
      overallPass: reviewedTargetPass && overdueTargetPass,
    };
  }, [submissions]);

  const exportSelectedPharmacyTrendCsv = () => {
    if (!selectedPharmacyTrend) return;
    const rows = [
      ["# Included metadata: review_checklist, structured_rejection, high_risk_fields, schema_validation, policy_version, decision_signature"],
      ["date", "pharmacy_id", "submitted", "approved", "rejected", "total"],
      ...selectedPharmacyTrendRows.map((row) => [
        row.key,
        selectedPharmacyTrend,
        row.submitted,
        row.approved,
        row.rejected,
        row.total,
      ]),
    ];
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `moh-pharmacy-risk-trend-${selectedPharmacyTrend}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const exportGovernanceSummaryCsv = () => {
    const g = governanceSummary;
    const rows = [
      ["# Included metadata: review_checklist, structured_rejection, high_risk_fields, schema_validation, policy_version, decision_signature"],
      ["metric", "value", "target", "status"],
      ["week_start", g.weekStart, "", ""],
      ["week_end", g.weekEnd, "", ""],
      ["submitted_total", g.submittedTotal, "", ""],
      ["reviewed_total", g.reviewedTotal, "", ""],
      ["reviewed_within_24h", g.reviewedWithin24h, "", ""],
      [
        "reviewed_within_24h_rate_percent",
        g.reviewedWithin24hRate,
        `>=${g.targetReviewedWithin24h}`,
        g.reviewedTargetPass ? "PASS" : "FAIL",
      ],
      ["overdue_count", g.overdue, "", ""],
      [
        "overdue_rate_percent",
        g.overdueRate,
        `<=${g.targetOverdueRateMax}`,
        g.overdueTargetPass ? "PASS" : "FAIL",
      ],
      ["overall_status", g.overallPass ? "PASS" : "FAIL", "", ""],
    ];
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `moh-governance-summary-${g.weekEnd}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const toggleOpsChecklist = (key) => {
    setOpsChecklist((current) => ({
      ...current,
      [key]: !current[key],
    }));
  };

  const createEscalationCase = (item) => {
    const due = new Date();
    due.setDate(due.getDate() + (item.severity === "high" ? 1 : item.severity === "medium" ? 2 : 3));
    const newCase = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      title: item.title,
      detail: item.detail,
      severity: item.severity,
      status: "open",
      owner: "MOH Compliance Officer",
      dueDate: due.toISOString().slice(0, 10),
    };
    setEscalationCases((current) => [newCase, ...current].slice(0, 100));
  };

  const updateEscalationCase = (caseId, patch) => {
    setEscalationCases((current) =>
      current.map((entry) => (entry.id === caseId ? { ...entry, ...patch, updatedAt: new Date().toISOString() } : entry))
    );
  };

  const exportEscalationCasesCsv = () => {
    if (!escalationCases.length) return;
    const rows = [
      ["# Included metadata: review_checklist, structured_rejection, high_risk_fields, schema_validation, policy_version, decision_signature"],
      ["case_id", "created_at", "title", "detail", "severity", "status", "owner", "due_date", "updated_at"],
      ...escalationCases.map((entry) => [
        entry.id,
        entry.createdAt || "",
        entry.title || "",
        entry.detail || "",
        entry.severity || "",
        entry.status || "",
        entry.owner || "",
        entry.dueDate || "",
        entry.updatedAt || "",
      ]),
    ];
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `moh-escalation-cases-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const updateReviewChecklist = (snapshotId, key) => {
    setReviewChecklistById((current) => ({
      ...current,
      [snapshotId]: {
        integrity: false,
        signature: false,
        notes: false,
        ...(current[snapshotId] || {}),
        [key]: !(current[snapshotId] || {})[key],
      },
    }));
  };

  const getEscalationDueMeta = (entry) => {
    if (!entry?.dueDate) return { label: "No due date", status: "neutral" };
    const due = new Date(entry.dueDate);
    if (Number.isNaN(due.getTime())) return { label: "Invalid due date", status: "neutral" };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dueMs = new Date(due.toISOString().slice(0, 10)).getTime();
    const diffDays = Math.round((dueMs - today.getTime()) / 86400000);
    if (diffDays < 0) {
      return { label: `Overdue by ${Math.abs(diffDays)} day(s)`, status: "overdue" };
    }
    if (diffDays === 0) {
      return { label: "Due today", status: "due" };
    }
    return { label: `Due in ${diffDays} day(s)`, status: diffDays <= 2 ? "due" : "ok" };
  };

  const filteredSubmissions = useMemo(() => {
    const nowMs = Date.now();
    return submissions.filter((entry) => {
      const status = String(entry.status || "").toLowerCase();
      const submittedMs = new Date(entry.submittedAt || 0).getTime();
      const ageHours = Number.isFinite(submittedMs) ? (nowMs - submittedMs) / 3600000 : 0;

      const queueMatch =
        queueView === "all"
          ? true
          : queueView === "new"
            ? status === "submitted" && ageHours < 24
            : queueView === "overdue"
              ? status === "submitted" && ageHours >= 24
              : status === queueView;
      if (!queueMatch) return false;

      if (registryStatus !== "all" && status !== registryStatus) return false;

      const pharmacyNeedle = registryPharmacy.trim().toLowerCase();
      if (pharmacyNeedle && !String(entry.pharmacyId || "").toLowerCase().includes(pharmacyNeedle)) return false;

      const actorNeedle = selectedReviewDoctorId.trim().toLowerCase();
      if (actorNeedle) {
        const actorMatch = [entry.signedBy, entry.submittedBy, entry.reviewedBy]
          .map((value) => String(value || "").toLowerCase())
          .some((value) => value === actorNeedle);
        if (!actorMatch) return false;
      }

      const searchNeedle = registrySearch.trim().toLowerCase();
      if (searchNeedle) {
        const haystack = [
          entry.id,
          entry.label,
          entry.pharmacyId,
          entry.signedBy,
          entry.submittedBy,
          entry.reviewedBy,
          entry.submissionNote,
          entry.reviewNote,
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(searchNeedle)) return false;
      }

      if (registryFrom) {
        const fromMs = new Date(`${registryFrom}T00:00:00`).getTime();
        if (!Number.isFinite(submittedMs) || submittedMs < fromMs) return false;
      }
      if (registryTo) {
        const toMs = new Date(`${registryTo}T23:59:59`).getTime();
        if (!Number.isFinite(submittedMs) || submittedMs > toMs) return false;
      }
      return true;
    });
  }, [submissions, queueView, registryStatus, registryPharmacy, selectedReviewDoctorId, registrySearch, registryFrom, registryTo]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(filteredSubmissions.length / PAGE_SIZE)), [filteredSubmissions.length]);
  const currentPage = Math.min(page, totalPages);
  const pagedSubmissions = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredSubmissions.slice(start, start + PAGE_SIZE);
  }, [filteredSubmissions, currentPage]);

  const downloadFilteredRegistryCsv = () => {
    const rows = [
      ["# Included metadata: review_checklist, structured_rejection, high_risk_fields, schema_validation, policy_version, decision_signature"],
      [
        "snapshot_id",
        "label",
        "pharmacy_id",
        "risk_level",
        "status",
        "submitted_at",
        "submitted_by",
        "reviewed_at",
        "reviewed_by",
        "submission_note",
        "review_note",
        "review_checklist",
        "structured_rejection",
        "high_risk_fields",
        "schema_validation",
        "policy_version",
        "decision_signature",
      ],
      ...filteredSubmissions.map((entry) => [
        entry.id,
        entry.label || "",
        entry.pharmacyId || "",
        entry.riskLevel || "",
        entry.status || "",
        entry.submittedAt || "",
        entry.submittedBy || "",
        entry.reviewedAt || "",
        entry.reviewedBy || "",
        entry.submissionNote || "",
        entry.reviewNote || "",
        entry.reviewChecklist ? JSON.stringify(entry.reviewChecklist) : "",
        entry.structuredRejection ? JSON.stringify(entry.structuredRejection) : "",
        entry.highRisk ? JSON.stringify(entry.highRisk) : "",
        entry.schemaValidation ? JSON.stringify(entry.schemaValidation) : "",
        entry.policyVersion || "",
        entry.decisionSignatureHash || "",
      ]),
    ];
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `moh-snapshot-registry-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const drillByStatus = (status) => {
    setQueueView(status === "submitted" ? "all" : status);
    setRegistryStatus(status);
  };

  const drillByDayAndStatus = (dayKey, status) => {
    setRegistryFrom(dayKey);
    setRegistryTo(dayKey);
    if (status === "all") {
      setQueueView("all");
      setRegistryStatus("all");
      return;
    }
    setQueueView(status === "submitted" ? "all" : status);
    setRegistryStatus(status);
  };

  useEffect(() => {
    loadSubmissions();
    loadRegistryPreset();
    loadExportJobs();
    loadPolicies();
    try {
      const raw = localStorage.getItem(OPS_CHECKLIST_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setOpsChecklist((current) => ({ ...current, ...parsed }));
      }
      const caseRaw = localStorage.getItem(ESCALATION_CASES_KEY);
      if (caseRaw) {
        const parsedCases = JSON.parse(caseRaw);
        if (Array.isArray(parsedCases)) setEscalationCases(parsedCases);
      }
    } catch (_err) {
      // ignore malformed local storage
    }
  }, []);

  useEffect(() => {
    setPage(1);
  }, [queueView, registryStatus, registryPharmacy, registrySearch, registryFrom, registryTo]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      loadExportJobs();
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [exportJobSearch]);

  useEffect(() => {
    localStorage.setItem(OPS_CHECKLIST_KEY, JSON.stringify(opsChecklist));
  }, [opsChecklist]);

  useEffect(() => {
    localStorage.setItem(ESCALATION_CASES_KEY, JSON.stringify(escalationCases));
  }, [escalationCases]);

  useEffect(() => {
    const sectionIds = ["moh-overview", "moh-registry", "moh-validation", "moh-approvals", "moh-exports"];
    const elements = sectionIds.map((id) => document.getElementById(id)).filter(Boolean);
    if (!elements.length) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible.length) {
          setActiveSection(visible[0].target.id);
        }
      },
      { rootMargin: "-30% 0px -50% 0px", threshold: [0.1, 0.25, 0.5, 0.75] }
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <section className="panel moh-shell">
      <div className="moh-page-header">
        <div className="moh-page-header__copy">
          <span className="moh-eyebrow">Ministry of Health Oversight</span>
          <h2>MOH Reports</h2>
          <p className="meta">Monitor compliance snapshots, audit readiness, and enforcement workflows across pharmacies.</p>
        </div>
        <div className="moh-role-card">
          <span className="moh-role-card__label">Active role</span>
          <span className="moh-role-card__value">{mohRole}</span>
          <span className="moh-role-card__meta">
            {mohPermissions.canApprove ? "Supervisor access" : "Review only access"}
          </span>
          <span className={`moh-role-badge moh-role-badge--${mohRole}`}>Role: {mohRole}</span>
        </div>
      </div>
      <div className="moh-workspace">
        <aside className="moh-sidebar">
          <h3>MOH Workspace</h3>
          <p className="meta">Jump between governance, queue review, exports, and validation tools.</p>
          <nav className="moh-sidebar-nav">
            <a href="#moh-overview" className={activeSection === "moh-overview" ? "active" : ""}>
              Overview
            </a>
            <a href="#moh-registry" className={activeSection === "moh-registry" ? "active" : ""}>
              Registry
            </a>
            <a href="#moh-validation" className={activeSection === "moh-validation" ? "active" : ""}>
              Validation
            </a>
            <a href="#moh-approvals" className={activeSection === "moh-approvals" ? "active" : ""}>
              Approvals
            </a>
            <a href="#moh-exports" className={activeSection === "moh-exports" ? "active" : ""}>
              Export Jobs
            </a>
          </nav>
          <div className="moh-sidebar-card">
            <span className="meta">Governance window</span>
            <div className="form-row">
              <label>
                From
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                To
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>
            <button className="primary" onClick={generate}>
              Generate report
            </button>
            {report ? <pre className="notice">{JSON.stringify(report, null, 2)}</pre> : null}
          </div>
          <div className="moh-sidebar-card">
            <span className="meta">Registry presets</span>
            <div className="moh-sidebar-actions">
              <button className="ghost" type="button" onClick={loadRegistryPreset}>
                Load preset
              </button>
              <button className="ghost" type="button" onClick={saveRegistryPreset}>
                Save preset
              </button>
            </div>
          </div>
          <div className="moh-sidebar-card">
            <span className="meta">Export format</span>
            <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value)}>
              <option value="csv">csv</option>
              <option value="pdf">pdf-ready (html)</option>
            </select>
          </div>
        </aside>
        <main className="moh-main">
      <div className="form moh-risk-dashboard" id="moh-overview">
        <h3>Risk Dashboard</h3>
        <div className="moh-kpi-grid">
          <button className="moh-kpi-card" type="button" onClick={() => drillByStatus("all")}>
            <span className="moh-kpi-card__label">Total snapshots</span>
            <strong className="moh-kpi-card__value">{riskDashboard.total}</strong>
          </button>
          <button className="moh-kpi-card" type="button" onClick={() => drillByStatus("submitted")}>
            <span className="moh-kpi-card__label">Pending review</span>
            <strong className="moh-kpi-card__value">{riskDashboard.pending}</strong>
          </button>
          <button className="moh-kpi-card moh-kpi-card--amber" type="button" onClick={() => setQueueView("overdue")}>
            <span className="moh-kpi-card__label">Overdue (&gt;=24h)</span>
            <strong className="moh-kpi-card__value">{riskDashboard.overdue}</strong>
          </button>
          <button className="moh-kpi-card moh-kpi-card--red" type="button" onClick={() => setQueueView("overdue")}>
            <span className="moh-kpi-card__label">High-risk pending</span>
            <strong className="moh-kpi-card__value">{riskDashboard.highRisk}</strong>
          </button>
          <button className="moh-kpi-card moh-kpi-card--green" type="button" onClick={() => drillByStatus("approved")}>
            <span className="moh-kpi-card__label">Review completion rate</span>
            <strong className="moh-kpi-card__value">{riskDashboard.reviewRate}%</strong>
          </button>
        </div>
        <div className="moh-trend-chart">
          <div className="moh-trend-chart__legend">
            <span className="moh-trend-dot moh-trend-dot--submitted">Submitted</span>
            <span className="moh-trend-dot moh-trend-dot--approved">Approved</span>
            <span className="moh-trend-dot moh-trend-dot--rejected">Rejected</span>
          </div>
          <div className="moh-trend-chart__bars">
            {trendRows.map((row) => {
              const submittedHeight = (row.submitted / maxTrendTotal) * 100;
              const approvedHeight = (row.approved / maxTrendTotal) * 100;
              const rejectedHeight = (row.rejected / maxTrendTotal) * 100;
              return (
                <div key={row.key} className="moh-trend-bar-group">
                  <div className="moh-trend-bar-stack">
                    <button
                      type="button"
                      className="moh-trend-bar moh-trend-bar--submitted"
                      style={{ height: `${submittedHeight}%` }}
                      title={`${row.key} submitted: ${row.submitted}`}
                      onClick={() => drillByDayAndStatus(row.key, "submitted")}
                    />
                    <button
                      type="button"
                      className="moh-trend-bar moh-trend-bar--approved"
                      style={{ height: `${approvedHeight}%` }}
                      title={`${row.key} approved: ${row.approved}`}
                      onClick={() => drillByDayAndStatus(row.key, "approved")}
                    />
                    <button
                      type="button"
                      className="moh-trend-bar moh-trend-bar--rejected"
                      style={{ height: `${rejectedHeight}%` }}
                      title={`${row.key} rejected: ${row.rejected}`}
                      onClick={() => drillByDayAndStatus(row.key, "rejected")}
                    />
                  </div>
                  <button type="button" className="moh-trend-label" onClick={() => drillByDayAndStatus(row.key, "all")}>
                    {row.label}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="form moh-analytics-panel">
        <div className="moh-submissions-header">
          <h3>Operational Analytics</h3>
          <p className="meta">Live KPIs for SLA, data completeness, and policy adherence.</p>
          <button className="ghost" type="button" onClick={exportMohAnalyticsCsv}>
            Export analytics CSV
          </button>
        </div>
        <div className="moh-analytics-grid">
          <article className="moh-kpi-card">
            <span className="moh-kpi-card__label">Median review time</span>
            <strong className="moh-kpi-card__value">{reviewSla.median.toFixed(1)}h</strong>
            <span className="queue-meta moh-kpi-meta">P90: {reviewSla.p90.toFixed(1)}h â€¢ Reviewed: {reviewSla.reviewedCount}</span>
          </article>
          <article className="moh-kpi-card moh-kpi-card--amber">
            <span className="moh-kpi-card__label">Overdue backlog</span>
            <strong className="moh-kpi-card__value">{overdueBacklog.over24}</strong>
            <span className="queue-meta moh-kpi-meta">48h+: {overdueBacklog.over48}</span>
          </article>
          <article className="moh-kpi-card">
            <span className="moh-kpi-card__label">Schema completeness</span>
            <strong className="moh-kpi-card__value">{schemaCompleteness.avgScore}%</strong>
            <span className="queue-meta moh-kpi-meta">100% complete: {schemaCompleteness.fullyComplete}</span>
          </article>
          <article className="moh-kpi-card moh-kpi-card--green">
            <span className="moh-kpi-card__label">Latest policy adoption</span>
            <strong className="moh-kpi-card__value">{policyAdoption.pct}%</strong>
            <span className="queue-meta moh-kpi-meta">Policy: {policyAdoption.latestPolicy || "n/a"}</span>
          </article>
        </div>
        <div className="moh-analytics-grid">
          <article className="moh-kpi-card">
            <span className="moh-kpi-card__label">Selected pharmacy overdue</span>
            <strong className="moh-kpi-card__value">{pharmacyRiskKpi.overdue}</strong>
            <span className="queue-meta moh-kpi-meta">Pharmacy: {selectedPharmacyTrend || "all"}</span>
          </article>
          <article className="moh-kpi-card moh-kpi-card--amber">
            <span className="moh-kpi-card__label">Selected pharmacy review rate</span>
            <strong className="moh-kpi-card__value">{pharmacyRiskKpi.reviewRate}%</strong>
            <span className="queue-meta moh-kpi-meta">Trend delta: {pharmacyRiskKpi.trendDelta >= 0 ? "+" : ""}{pharmacyRiskKpi.trendDelta}%</span>
          </article>
          <article className="moh-kpi-card">
            <span className="moh-kpi-card__label">Weekly SLA compliance (latest)</span>
            <strong className="moh-kpi-card__value">{weeklySla[weeklySla.length - 1]?.pct || 0}%</strong>
            <span className="queue-meta moh-kpi-meta">Reviewed: {weeklySla[weeklySla.length - 1]?.reviewed || 0}</span>
          </article>
        </div>
        <div className="moh-analytics-bars">
          <div className="moh-submissions-header">
            <h4>Rejection Reason Mix</h4>
          </div>
          {rejectionMix.length ? (
            <div className="moh-bar-list">
              {rejectionMix.map((item) => (
                <div key={item.code} className="moh-bar-row">
                  <div className="moh-bar-label">
                    {item.label} <span className="meta">({item.count})</span>
                  </div>
                  <div className="moh-bar-track">
                    <div className="moh-bar-fill" style={{ width: `${item.pct}%` }} />
                  </div>
                  <div className="moh-bar-pct">{item.pct}%</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="notice">No rejection reasons logged yet.</p>
          )}
        </div>
        <div className="moh-analytics-bars">
          <div className="moh-submissions-header">
            <h4>Reviewer Leaderboard</h4>
          </div>
          {reviewerLeaderboard.length ? (
            <div className="moh-bar-list">
              {reviewerLeaderboard.map((row) => (
                <div key={row.reviewer} className="moh-bar-row moh-bar-row--leader">
                  <div className="moh-bar-label">{row.reviewer}</div>
                  <div className="moh-bar-track">
                    <div className="moh-bar-fill" style={{ width: `${Math.min(100, (row.reviewed / reviewerLeaderboard[0].reviewed) * 100)}%` }} />
                  </div>
                  <div className="moh-bar-pct">{row.reviewed}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="notice">No reviewer activity logged yet.</p>
          )}
        </div>
        <div className="moh-analytics-bars">
          <div className="moh-submissions-header">
            <h4>Weekly SLA Compliance (last 6 weeks)</h4>
          </div>
          <div className="moh-bar-list">
            {weeklySla.map((row) => (
              <div key={row.key} className="moh-bar-row">
                <div className="moh-bar-label">{row.label}</div>
                <div className="moh-bar-track">
                  <div className="moh-bar-fill" style={{ width: `${row.pct}%` }} />
                </div>
                <div className="moh-bar-pct">{row.pct}%</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="form moh-validation-panel" id="moh-validation">
        <h3>Compliance Snapshot Validation</h3>
        <div className="form-row">
          <label>
            Snapshot ID
            <input
              value={snapshotId}
              onChange={(e) => setSnapshotId(normalizeSnapshotId(e.target.value))}
              placeholder="e.g. 3a8d..."
            />
          </label>
          <button className="primary" type="button" onClick={validateSnapshot}>
            Run validation
          </button>
        </div>

        {validation ? (
          <article className="queue-card moh-validation-card">
            <div>
              <div className="queue-title">
                Snapshot {validation.snapshotId} | Pharmacy {validation.pharmacyId || "n/a"}
              </div>
              <div className="queue-meta">
                Signed by: {validation.signedBy || "n/a"} | Signed at:{" "}
                {validation.signedAt ? new Date(validation.signedAt).toLocaleString() : "n/a"}
              </div>
            </div>
            <div>
              <span
                className={`snapshot-integrity-badge ${
                  validation.overallValid ? "snapshot-integrity-badge--ok" : "snapshot-integrity-badge--bad"
                }`}
              >
                {validation.overallValid ? "Validation Passed" : "Validation Failed"}
              </span>
              <div className="queue-meta">
                I:{validation.integrityOk ? "OK" : "FAIL"} | S:{validation.signatureOk ? "OK" : "FAIL"} | C:
                {validation.chainOk ? "OK" : "FAIL"}
              </div>
              <div className="queue-meta">Validated at: {new Date(validation.validatedAt).toLocaleString()}</div>
            </div>
            <div className="queue-meta">
              Checksum: {validation.checksum || "n/a"}
              <br />
              Computed: {validation.computedChecksum || "n/a"}
              <br />
              Signature: {validation.signatureHash || "n/a"}
              <br />
              Expected signature: {validation.expectedSignatureHash || "n/a"}
              <br />
              Previous signature hash: {validation.previousSignatureHash || "n/a"}
            </div>
          </article>
        ) : null}
      </div>

      <div className="form moh-pharmacy-oversight-panel" id="moh-registry">
        <div className="moh-submissions-header">
          <h3>Pharmacy Oversight Board</h3>
          <p className="meta">Prioritized by overdue submissions and low review completion.</p>
        </div>
        <div className="queue-list">
          {pharmacyOversightRows.slice(0, 12).map((row) => (
            <article key={row.pharmacyId} className={`queue-card moh-pharmacy-oversight-card moh-pharmacy-oversight-card--${row.riskLevel}`}>
              <div>
                <div className="queue-title">{row.pharmacyId}</div>
                <div className="queue-meta">
                  Total: {row.total} | Pending: {row.submitted} | Approved: {row.approved} | Rejected: {row.rejected}
                </div>
                <div className="queue-meta">
                  Overdue (&gt;=24h): {row.overdue} | Review rate: {row.reviewRate}%
                </div>
              </div>
              <div className="queue-actions">
                <span className={`snapshot-integrity-badge ${row.riskLevel === "high" ? "snapshot-integrity-badge--bad" : row.riskLevel === "medium" ? "moh-risk-badge--amber" : "snapshot-integrity-badge--ok"}`}>
                  {row.riskLevel} risk
                </span>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    const nextPharmacy = row.pharmacyId === "unassigned" ? "" : row.pharmacyId;
                    setRegistryPharmacy(nextPharmacy);
                    setSelectedPharmacyTrend(nextPharmacy);
                    setQueueView(row.overdue > 0 ? "overdue" : "all");
                  }}
                >
                  Drill down
                </button>
              </div>
            </article>
          ))}
          {!pharmacyOversightRows.length ? <p className="notice">No pharmacy submissions available yet.</p> : null}
        </div>

        <div className="moh-pharmacy-trend-panel">
          <div className="moh-submissions-header">
            <h4>Risk Trend By Pharmacy (14 days)</h4>
            <div className="form-row">
              <label>
                Pharmacy
                <select value={selectedPharmacyTrend} onChange={(event) => setSelectedPharmacyTrend(event.target.value)}>
                  <option value="">Select pharmacy</option>
                  {pharmacyOversightRows.map((row) => (
                    <option key={row.pharmacyId} value={row.pharmacyId === "unassigned" ? "" : row.pharmacyId}>
                      {row.pharmacyId}
                    </option>
                  ))}
                </select>
              </label>
              <button className="ghost" type="button" onClick={exportSelectedPharmacyTrendCsv} disabled={!selectedPharmacyTrend}>
                Export pharmacy CSV
              </button>
            </div>
          </div>
          {selectedPharmacyTrend ? (
            <div className="moh-trend-chart moh-pharmacy-mini-trend">
              <div className="moh-trend-chart__legend">
                <span className="moh-trend-dot moh-trend-dot--submitted">Submitted</span>
                <span className="moh-trend-dot moh-trend-dot--approved">Approved</span>
                <span className="moh-trend-dot moh-trend-dot--rejected">Rejected</span>
              </div>
              <div className="moh-trend-chart__bars">
                {selectedPharmacyTrendRows.map((row) => {
                  const submittedHeight = (row.submitted / selectedPharmacyMaxTrendTotal) * 100;
                  const approvedHeight = (row.approved / selectedPharmacyMaxTrendTotal) * 100;
                  const rejectedHeight = (row.rejected / selectedPharmacyMaxTrendTotal) * 100;
                  return (
                    <div key={row.key} className="moh-trend-bar-group">
                      <div className="moh-trend-bar-stack">
                        <div className="moh-trend-bar moh-trend-bar--submitted" style={{ height: `${submittedHeight}%` }} title={`${row.key} submitted: ${row.submitted}`} />
                        <div className="moh-trend-bar moh-trend-bar--approved" style={{ height: `${approvedHeight}%` }} title={`${row.key} approved: ${row.approved}`} />
                        <div className="moh-trend-bar moh-trend-bar--rejected" style={{ height: `${rejectedHeight}%` }} title={`${row.key} rejected: ${row.rejected}`} />
                      </div>
                      <span className="moh-trend-label">{row.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="notice">Pick a pharmacy above or click Drill down from an oversight card.</p>
          )}
        </div>
      </div>

      <div className="form moh-record-selector-panel">
        <div className="moh-submissions-header">
          <h3>Record Review Selector</h3>
          <p className="meta">Choose a specific pharmacy and doctor/reviewer to inspect records quickly.</p>
        </div>
        <div className="form-row">
          <label>
            Pharmacy
            <select
              value={registryPharmacy}
              onChange={(event) => {
                const next = event.target.value;
                setRegistryPharmacy(next);
                setSelectedPharmacyTrend(next);
              }}
            >
              <option value="">All pharmacies</option>
              {reviewSelectorOptions.pharmacyIds.map((pharmacyId) => (
                <option key={pharmacyId} value={pharmacyId}>
                  {pharmacyId}
                </option>
              ))}
            </select>
          </label>
          <label>
            Doctor/Reviewer ID
            <select
              value={selectedReviewDoctorId}
              onChange={(event) => {
                const next = event.target.value;
                setSelectedReviewDoctorId(next);
              }}
            >
              <option value="">All doctors/reviewers</option>
              {reviewSelectorOptions.doctorOrReviewerIds.map((actorId) => (
                <option key={actorId} value={actorId}>
                  {actorId}
                </option>
              ))}
            </select>
          </label>
          <div className="queue-actions">
            <button
              className="ghost"
              type="button"
              onClick={() => {
                setQueueView("all");
                setRegistryStatus("all");
              }}
            >
              Apply selector
            </button>
            <button
              className="ghost"
              type="button"
              onClick={() => {
                setRegistryPharmacy("");
                setSelectedPharmacyTrend("");
                setSelectedReviewDoctorId("");
              }}
            >
              Clear selector
            </button>
          </div>
        </div>
      </div>

      <div className="form moh-ops-panel">
        <div className="moh-submissions-header">
          <h3>MOH Operations Control</h3>
          <p className="meta">Daily SOP cadence and escalation triggers.</p>
        </div>
        <div className="moh-ops-layout">
          <div className="moh-ops-checklist">
            <h4>Daily Checklist</h4>
            <label className="checkbox">
              <input type="checkbox" checked={opsChecklist.intakeSweep} onChange={() => toggleOpsChecklist("intakeSweep")} />
              Intake sweep (08:00-09:00)
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={opsChecklist.riskTriage} onChange={() => toggleOpsChecklist("riskTriage")} />
              Risk triage (09:00-10:00)
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={opsChecklist.decisionBlock} onChange={() => toggleOpsChecklist("decisionBlock")} />
              Decision block (10:00-12:00)
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={opsChecklist.exportControl} onChange={() => toggleOpsChecklist("exportControl")} />
              Export control window (14:00-15:00)
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={opsChecklist.exceptionHandling} onChange={() => toggleOpsChecklist("exceptionHandling")} />
              Exception handling (16:00-17:00)
            </label>
          </div>
          <div className="moh-ops-kpis">
            <h4>Threshold Watch</h4>
            <div className="queue-meta">Overdue queue: {registrySummary.overdue}</div>
            <div className="queue-meta">High-risk pharmacies: {escalationItems.highRiskPharmacies}</div>
            <div className="queue-meta">Low-review pharmacies (&lt;70%): {escalationItems.lowReviewPharmacies}</div>
            <div className="queue-meta">Platform review rate: {riskDashboard.reviewRate}%</div>
          </div>
        </div>
        <div className="queue-list">
          {escalationItems.items.map((item) => (
            <article key={item.id} className={`queue-card moh-escalation-card moh-escalation-card--${item.severity}`}>
              <div>
                <div className="queue-title">{item.title}</div>
                <div className="queue-meta">{item.detail}</div>
              </div>
              {item.onClick ? (
                <div className="queue-actions">
                  <button className="ghost" type="button" onClick={item.onClick}>
                    Open queue
                  </button>
                  <button className="ghost" type="button" onClick={() => createEscalationCase(item)}>
                    Create case
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </div>

      <div className="form moh-escalation-register-panel">
        <div className="moh-submissions-header">
          <h3>Escalation Case Register</h3>
          <div className="form-row">
            <span className="meta">
              Open: {escalationCases.filter((entry) => entry.status !== "closed").length} / Total: {escalationCases.length}
            </span>
            <button className="ghost" type="button" onClick={exportEscalationCasesCsv} disabled={!escalationCases.length}>
              Export cases CSV
            </button>
          </div>
        </div>
        <div className="queue-list">
          {escalationCases.map((entry) => (
            <article
              key={entry.id}
              className={`queue-card moh-escalation-card moh-escalation-card--${entry.severity || "low"} ${
                getEscalationDueMeta(entry).status === "overdue" ? "moh-escalation-card--overdue" : ""
              }`}
            >
              <div>
                <div className="queue-title">{entry.title}</div>
                <div className="queue-meta">{entry.detail}</div>
                <div className="queue-meta">
                  Case: {entry.id} | Created: {entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "n/a"}
                </div>
                <div className={`moh-case-due-badge moh-case-due-badge--${getEscalationDueMeta(entry).status}`}>
                  {getEscalationDueMeta(entry).label}
                </div>
              </div>
              <div className="queue-actions">
                <label>
                  Status
                  <select
                    value={entry.status || "open"}
                    onChange={(event) => updateEscalationCase(entry.id, { status: event.target.value })}
                  >
                    <option value="open">open</option>
                    <option value="in_progress">in_progress</option>
                    <option value="closed">closed</option>
                  </select>
                </label>
                <label>
                  Owner
                  <input value={entry.owner || ""} onChange={(event) => updateEscalationCase(entry.id, { owner: event.target.value })} />
                </label>
                <label>
                  Due date
                  <input
                    type="date"
                    value={entry.dueDate || ""}
                    onChange={(event) => updateEscalationCase(entry.id, { dueDate: event.target.value })}
                  />
                </label>
              </div>
            </article>
          ))}
          {!escalationCases.length ? <p className="notice">No escalation cases created yet.</p> : null}
        </div>
      </div>

      <div className="form moh-governance-summary-panel">
        <div className="moh-submissions-header">
          <h3>Weekly Governance Summary</h3>
          <button className="ghost" type="button" onClick={exportGovernanceSummaryCsv}>
            Export leadership CSV
          </button>
        </div>
        <div className="queue-meta">
          Window: {governanceSummary.weekStart} to {governanceSummary.weekEnd} (last 7 days)
        </div>
        <div className="moh-kpi-grid">
          <article className="moh-kpi-card">
            <span className="moh-kpi-card__label">Reviewed within 24h</span>
            <strong className="moh-kpi-card__value">{governanceSummary.reviewedWithin24hRate}%</strong>
            <span
              className={`snapshot-integrity-badge ${
                governanceSummary.reviewedTargetPass ? "snapshot-integrity-badge--ok" : "snapshot-integrity-badge--bad"
              }`}
            >
              {governanceSummary.reviewedTargetPass ? "PASS" : "FAIL"} target &gt;= {governanceSummary.targetReviewedWithin24h}%
            </span>
          </article>
          <article className="moh-kpi-card">
            <span className="moh-kpi-card__label">Overdue rate</span>
            <strong className="moh-kpi-card__value">{governanceSummary.overdueRate}%</strong>
            <span
              className={`snapshot-integrity-badge ${
                governanceSummary.overdueTargetPass ? "snapshot-integrity-badge--ok" : "snapshot-integrity-badge--bad"
              }`}
            >
              {governanceSummary.overdueTargetPass ? "PASS" : "FAIL"} target &lt;= {governanceSummary.targetOverdueRateMax}%
            </span>
          </article>
          <article className="moh-kpi-card">
            <span className="moh-kpi-card__label">Overall governance</span>
            <strong className="moh-kpi-card__value">{governanceSummary.overallPass ? "PASS" : "FAIL"}</strong>
            <span className="queue-meta">
              Submitted: {governanceSummary.submittedTotal} | Reviewed: {governanceSummary.reviewedTotal} | Overdue: {governanceSummary.overdue}
            </span>
          </article>
        </div>
      </div>

      <div className="form moh-submissions-panel" id="moh-approvals">
        <div className="moh-submissions-header">
          <h3>Submitted Snapshot Approvals</h3>
          <div className="form-row">
            <button className="ghost" type="button" onClick={saveRegistryPreset}>
              Save filters
            </button>
            <button className="ghost" type="button" onClick={loadRegistryPreset}>
              Load filters
            </button>
            <button className="ghost" type="button" onClick={downloadFilteredRegistryCsv} disabled={!filteredSubmissions.length}>
              Export filtered CSV
            </button>
            <button className="ghost" type="button" onClick={loadSubmissions} disabled={loadingSubmissions}>
              {loadingSubmissions ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>

        <div className="notice">
          Total: {registrySummary.total} | Submitted: {registrySummary.submitted} | Approved: {registrySummary.approved} |
          Rejected: {registrySummary.rejected} | New (&lt;24h): {registrySummary.newQueue} | Overdue (&gt;=24h):{" "}
          {registrySummary.overdue}
        </div>
        {actionNotice ? <div className="notice">{actionNotice}</div> : null}

        <div className="moh-registry-queue">
          <button className={`tab ${queueView === "all" ? "active" : ""}`} type="button" onClick={() => setQueueView("all")}>
            All
          </button>
          <button className={`tab ${queueView === "new" ? "active" : ""}`} type="button" onClick={() => setQueueView("new")}>
            New Queue
          </button>
          <button
            className={`tab ${queueView === "overdue" ? "active" : ""}`}
            type="button"
            onClick={() => setQueueView("overdue")}
          >
            Overdue
          </button>
          <button
            className={`tab ${queueView === "approved" ? "active" : ""}`}
            type="button"
            onClick={() => setQueueView("approved")}
          >
            Approved
          </button>
          <button
            className={`tab ${queueView === "rejected" ? "active" : ""}`}
            type="button"
            onClick={() => setQueueView("rejected")}
          >
            Rejected
          </button>
        </div>

        <div className="form-row">
          <label>
            Status
            <select value={registryStatus} onChange={(e) => setRegistryStatus(e.target.value)}>
              <option value="all">all</option>
              <option value="submitted">submitted</option>
              <option value="approved">approved</option>
              <option value="rejected">rejected</option>
            </select>
          </label>
          <label>
            Pharmacy ID
            <input value={registryPharmacy} onChange={(e) => setRegistryPharmacy(e.target.value)} placeholder="Filter by pharmacy id" />
          </label>
          <label>
            Search
            <input value={registrySearch} onChange={(e) => setRegistrySearch(e.target.value)} placeholder="Snapshot, note, reviewer..." />
          </label>
          <label>
            Submitted from
            <input type="date" value={registryFrom} onChange={(e) => setRegistryFrom(e.target.value)} />
          </label>
          <label>
            Submitted to
            <input type="date" value={registryTo} onChange={(e) => setRegistryTo(e.target.value)} />
          </label>
        </div>

        {pagedSubmissions.length ? (
          <div className="queue-list">
            {pagedSubmissions.map((entry) => {
              const status = String(entry.status || "").toLowerCase() || "not_submitted";
              return (
                <article key={entry.id} className="queue-card moh-submission-card">
                  <div>
                    <div className="queue-title">
                      {entry.label || "Compliance Snapshot"} | Pharmacy {entry.pharmacyId || "n/a"}
                    </div>
                    <div className="moh-risk-row">
                      <span
                        className={`moh-risk-badge moh-risk-badge--${entry.riskLevel || "low"}`}
                      >
                        Risk: {entry.riskLevel || "low"}
                      </span>
                      <span
                        className={`moh-schema-badge ${
                          entry.schemaValidation?.isValid === false
                            ? "moh-schema-badge--bad"
                            : "moh-schema-badge--ok"
                        }`}
                      >
                        {entry.schemaValidation?.isValid === false ? "Schema issues" : "Schema ok"}
                      </span>
                    </div>
                    {entry.schemaValidation?.errors?.length ? (
                      <div className="moh-schema-list moh-schema-list--error">
                        Errors: {entry.schemaValidation.errors.join(", ")}
                      </div>
                    ) : null}
                    {entry.schemaValidation?.warnings?.length ? (
                      <div className="moh-schema-list moh-schema-list--warn">
                        Warnings: {entry.schemaValidation.warnings.join(", ")}
                      </div>
                    ) : null}
                    {(() => {
                      const completeness = computeCompleteness(entry);
                      return (
                        <div className="moh-completeness">
                          <span
                            className={`snapshot-integrity-badge ${
                              completeness.score >= 90
                                ? "snapshot-integrity-badge--ok"
                                : completeness.score >= 70
                                  ? "moh-risk-badge--amber"
                                  : "snapshot-integrity-badge--bad"
                            }`}
                          >
                            Completeness {completeness.score}%
                          </span>
                          {completeness.missing.length ? (
                            <span className="queue-meta">
                              Missing: {completeness.missing.map((item) => item.label).join(", ")}
                            </span>
                          ) : (
                            <span className="queue-meta">All required fields present.</span>
                          )}
                        </div>
                      );
                    })()}
                    <div className="queue-meta">
                      Snapshot: {entry.id}
                      <br />
                      Submitted by: {entry.submittedBy || "n/a"} at{" "}
                      {entry.submittedAt ? new Date(entry.submittedAt).toLocaleString() : "n/a"}
                    </div>
                    {entry.submissionNote ? <p className="queue-meta">Submission note: {entry.submissionNote}</p> : null}
                    {Array.isArray(entry.evidence) && entry.evidence.length ? (
                      <div className="moh-evidence-strip">
                        <span className="meta">Evidence attached: {entry.evidence.length}</span>
                        <button
                          className="ghost"
                          type="button"
                          onClick={() =>
                            setEvidenceModal({
                              open: true,
                              snapshotId: entry.id,
                              files: entry.evidence,
                            })
                          }
                        >
                          View evidence
                        </button>
                      </div>
                    ) : (
                      <div className="queue-meta">Evidence attached: 0</div>
                    )}
                    {entry.reviewedAt ? (
                      <p className="queue-meta">
                        Reviewed by {entry.reviewedBy || "n/a"} at {new Date(entry.reviewedAt).toLocaleString()}
                        {entry.reviewNote ? ` | Note: ${entry.reviewNote}` : ""}
                      </p>
                    ) : null}
                  </div>
                  <div className="queue-actions">
                    <span
                      className={`snapshot-integrity-badge ${
                        status === "approved"
                          ? "snapshot-integrity-badge--ok"
                          : status === "rejected"
                            ? "snapshot-integrity-badge--bad"
                            : ""
                      }`}
                    >
                      {status}
                    </span>
                    {recentApprovalById[entry.id] ? (
                      <span className="moh-inline-status-chip">Approved just now</span>
                    ) : null}
                    {entry.riskLevel === "high" ? (
                      <div className="moh-high-risk-panel">
                        <span className="meta">High-risk required fields</span>
                        <label>
                          Reason code
                          <select
                            value={highRiskById[entry.id]?.reasonCode || ""}
                            onChange={(event) =>
                              setHighRiskById((current) => ({
                                ...current,
                                [entry.id]: {
                                  ...(current[entry.id] || {}),
                                  reasonCode: event.target.value,
                                },
                              }))
                            }
                          >
                            <option value="">Select reason</option>
                            {highRiskReasonOptions.map((reason) => (
                              <option key={reason.code} value={reason.code}>
                                {reason.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Corrective action plan
                          <textarea
                            rows={3}
                            value={highRiskById[entry.id]?.actionPlan || ""}
                            onChange={(event) =>
                              setHighRiskById((current) => ({
                                ...current,
                                [entry.id]: {
                                  ...(current[entry.id] || {}),
                                  actionPlan: event.target.value,
                                },
                              }))
                            }
                            placeholder="Describe remediation steps and timeline."
                          />
                        </label>
                      </div>
                    ) : null}
                    <div className="moh-review-checklist">
                      <span className="meta">Review checklist</span>
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={Boolean(reviewChecklistById[entry.id]?.integrity)}
                          onChange={() => updateReviewChecklist(entry.id, "integrity")}
                        />
                        Integrity validated
                      </label>
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={Boolean(reviewChecklistById[entry.id]?.signature)}
                          onChange={() => updateReviewChecklist(entry.id, "signature")}
                        />
                        Signature verified
                      </label>
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={Boolean(reviewChecklistById[entry.id]?.notes)}
                          onChange={() => updateReviewChecklist(entry.id, "notes")}
                        />
                        Notes checked
                      </label>
                    </div>
                    <label>
                      Policy version
                      <select
                        value={policyById[entry.id] || ""}
                        onChange={(event) =>
                          setPolicyById((current) => ({
                            ...current,
                            [entry.id]: event.target.value,
                          }))
                        }
                      >
                        <option value="">Select policy</option>
                        {policyOptions.map((policy) => (
                          <option key={policy.code} value={policy.code}>
                            {policy.label}
                          </option>
                        ))}
                      </select>
                      {!policyOptions.length ? (
                        <span className="queue-meta">No active policies available.</span>
                      ) : null}
                    </label>
                    <div className="moh-rejection-panel">
                      <label>
                        Structured rejection reason
                        <select
                          value={structuredRejectionById[entry.id]?.code || ""}
                          onChange={(event) =>
                            setStructuredRejectionById((current) => ({
                              ...current,
                              [entry.id]: {
                                ...(current[entry.id] || {}),
                                code: event.target.value,
                              },
                            }))
                          }
                        >
                          <option value="">Select reason</option>
                          {REJECTION_REASON_OPTIONS.map((reason) => (
                            <option key={reason.code} value={reason.code}>
                              {reason.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Additional note (optional)
                        <input
                          value={structuredRejectionById[entry.id]?.note || ""}
                          onChange={(event) =>
                            setStructuredRejectionById((current) => ({
                              ...current,
                              [entry.id]: {
                                ...(current[entry.id] || {}),
                                note: event.target.value,
                              },
                            }))
                          }
                          placeholder="Add context for rejection"
                        />
                      </label>
                    </div>
                    <label>
                      Review note
                      <input
                        value={decisionNotesById[entry.id] || ""}
                        onChange={(event) =>
                          setDecisionNotesById((current) => ({
                            ...current,
                            [entry.id]: event.target.value,
                          }))
                        }
                        placeholder="Optional rationale for decision"
                      />
                    </label>
                    <div className="moh-submission-actions">
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => setSnapshotModal({ open: true, entry })}
                      >
                        View snapshot
                      </button>
                      <button className="ghost" type="button" onClick={() => validateSnapshotById(entry.id)}>
                        Validate
                      </button>
                      <button
                        className="primary"
                        type="button"
                        onClick={() => decideSubmission(entry.id, "approved")}
                        disabled={!mohPermissions.canApprove || Boolean(decidingById[entry.id])}
                        title={!mohPermissions.canApprove ? "Supervisor role required" : ""}
                      >
                        {decidingById[entry.id] === "approved" ? "Approving..." : "Approve"}
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => decideSubmission(entry.id, "rejected")}
                        disabled={!mohPermissions.canApprove || Boolean(decidingById[entry.id])}
                        title={!mohPermissions.canApprove ? "Supervisor role required" : ""}
                      >
                        {decidingById[entry.id] === "rejected" ? "Rejecting..." : "Reject"}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="notice">No snapshots match current queue/filter selection.</p>
        )}

        <div className="moh-registry-pagination">
          <button className="ghost" type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={currentPage <= 1}>
            Prev
          </button>
          <span className="meta">
            Page {currentPage} / {totalPages}
          </span>
          <button
            className="ghost"
            type="button"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={currentPage >= totalPages}
          >
            Next
          </button>
        </div>
      </div>

      {evidenceModal.open ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <article className="modal moh-evidence-modal">
            <div className="modal-header">
              <h3>Snapshot Evidence | {evidenceModal.snapshotId}</h3>
              <button className="ghost" type="button" onClick={() => setEvidenceModal({ open: false, snapshotId: "", files: [] })}>
                Close
              </button>
            </div>
            <div className="modal-body">
              <div className="moh-evidence-grid">
                {(evidenceModal.files || []).map((file, index) => (
                  <article key={`${file.name || "file"}-${index}`} className="moh-evidence-card">
                    <div className="queue-title">{file.name || "evidence"}</div>
                    <div className="queue-meta">{file.mimeType || "application/octet-stream"}</div>
                    <div className="queue-meta">{Number(file.bytes || 0)} bytes</div>
                    {String(file.dataUrl || "").startsWith("data:image/") ? (
                      <img className="moh-evidence-image" src={file.dataUrl} alt={file.name || "Evidence"} />
                    ) : (
                      <a href={file.dataUrl} target="_blank" rel="noreferrer" className="ghost">
                        Open file
                      </a>
                    )}
                    {file.note ? <div className="queue-meta">{file.note}</div> : null}
                  </article>
                ))}
              </div>
            </div>
          </article>
        </div>
      ) : null}

      {snapshotModal.open && snapshotModal.entry ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <article className="modal moh-evidence-modal">
            <div className="modal-header">
              <h3>Submitted Snapshot | {snapshotModal.entry.id}</h3>
              <button className="ghost" type="button" onClick={() => setSnapshotModal({ open: false, entry: null })}>
                Close
              </button>
            </div>
            <div className="modal-body">
              <div className="queue-meta">
                Label: {snapshotModal.entry.label || "Compliance Snapshot"}
                <br />
                Pharmacy: {snapshotModal.entry.pharmacyId || "n/a"}
                <br />
                Status: {snapshotModal.entry.status || "submitted"}
                <br />
                Submitted by: {snapshotModal.entry.submittedBy || "n/a"} at{" "}
                {snapshotModal.entry.submittedAt ? new Date(snapshotModal.entry.submittedAt).toLocaleString() : "n/a"}
                <br />
                Reviewed by: {snapshotModal.entry.reviewedBy || "n/a"} at{" "}
                {snapshotModal.entry.reviewedAt ? new Date(snapshotModal.entry.reviewedAt).toLocaleString() : "n/a"}
              </div>
              {snapshotModal.entry.submissionNote ? (
                <div className="notice">Submission note: {snapshotModal.entry.submissionNote}</div>
              ) : null}
              {snapshotModal.entry.reviewNote ? <div className="notice">Review note: {snapshotModal.entry.reviewNote}</div> : null}
              <div className="moh-evidence-grid">
                {(snapshotModal.entry.evidence || []).map((file, index) => (
                  <article key={`${file.name || "file"}-${index}`} className="moh-evidence-card">
                    <div className="queue-title">{file.name || "evidence"}</div>
                    <div className="queue-meta">{file.mimeType || "application/octet-stream"}</div>
                    <div className="queue-meta">{Number(file.bytes || 0)} bytes</div>
                    {String(file.dataUrl || "").startsWith("data:image/") ? (
                      <img className="moh-evidence-image" src={file.dataUrl} alt={file.name || "Evidence"} />
                    ) : (
                      <a href={file.dataUrl} target="_blank" rel="noreferrer" className="ghost">
                        Open file
                      </a>
                    )}
                  </article>
                ))}
                {!(snapshotModal.entry.evidence || []).length ? (
                  <div className="queue-meta">No evidence files attached for this submission.</div>
                ) : null}
              </div>
            </div>
          </article>
        </div>
      ) : null}

      <div className="form moh-export-jobs-panel" id="moh-exports">
        <div className="moh-submissions-header">
          <h3>Immutable Export Jobs</h3>
          <div className="form-row">
            <label>
              Format
              <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value)}>
                <option value="csv">csv</option>
                <option value="pdf">pdf-ready (html)</option>
              </select>
            </label>
            <button
              className="primary"
              type="button"
              onClick={createExportJob}
              disabled={!mohPermissions.canCreateExport || creatingExportJob}
              title={!mohPermissions.canCreateExport ? "Supervisor role required" : ""}
            >
              {creatingExportJob ? "Creating..." : "Create export job"}
            </button>
            <button className="ghost" type="button" onClick={loadExportJobs} disabled={loadingExportJobs}>
              {loadingExportJobs ? "Refreshing..." : "Refresh jobs"}
            </button>
          </div>
        </div>
        <div className="form-row">
          <label>
            Search jobs
            <input
              value={exportJobSearch}
              onChange={(e) => setExportJobSearch(e.target.value)}
              placeholder="Job id, file, checksum, actor..."
            />
          </label>
        </div>
        <div className="notice">Total jobs: {exportJobsTotal}</div>
        <div className="queue-list">
          {exportJobs.map((job) => (
            <article key={job.id} className="queue-card moh-export-job-card">
              <div>
                <div className="queue-title">
                  {job.fileName || `moh-export-${job.id}`} | {job.format}
                </div>
                <div className="queue-meta">
                  Job: {job.id} | Scope: {job.scope} | Rows: {job.rowCount}
                </div>
                <div className="queue-meta">
                  Status: {job.status} | Immutable: {job.immutable ? "yes" : "no"} | Created:{" "}
                  {job.createdAt ? new Date(job.createdAt).toLocaleString() : "n/a"}
                </div>
                <div className="queue-meta">Checksum: {job.checksum || "n/a"}</div>
                <div className="queue-meta">
                  Approval:{" "}
                  <span
                    className={`snapshot-integrity-badge ${
                      job.approvalStatus === "approved"
                        ? "snapshot-integrity-badge--ok"
                        : job.approvalStatus === "rejected"
                          ? "snapshot-integrity-badge--bad"
                          : ""
                    }`}
                  >
                    {job.approvalStatus || "pending"}
                  </span>{" "}
                  | Locked: {job.locked ? "yes" : "no"}
                </div>
                <div className="queue-meta">
                  Reviewer: {job.approvalReviewerId || "n/a"} | Reviewed at:{" "}
                  {job.approvalReviewedAt ? new Date(job.approvalReviewedAt).toLocaleString() : "n/a"}
                </div>
                <div className="moh-export-job-timeline">
                  <span className="moh-export-chip">Created: {job.createdAt ? new Date(job.createdAt).toLocaleString() : "n/a"}</span>
                  {job.approvalReviewedAt ? (
                    <span className="moh-export-chip moh-export-chip--review">
                      Reviewed: {new Date(job.approvalReviewedAt).toLocaleString()}
                    </span>
                  ) : null}
                  {job.lockedAt ? (
                    <span className="moh-export-chip moh-export-chip--lock">
                      Locked: {new Date(job.lockedAt).toLocaleString()}
                    </span>
                  ) : null}
                  {job.unlockedAt ? (
                    <span className="moh-export-chip moh-export-chip--unlock">
                      Unlocked: {new Date(job.unlockedAt).toLocaleString()}
                    </span>
                  ) : null}
                </div>
                {job.approvalReason ? <div className="queue-meta">Reason: {job.approvalReason}</div> : null}
                {job.approvalSignatureHash ? <div className="queue-meta">Signed hash: {job.approvalSignatureHash}</div> : null}
                {job.locked ? (
                  <div className="queue-meta">
                    Locked by: {job.lockedBy || "n/a"} | Locked at:{" "}
                    {job.lockedAt ? new Date(job.lockedAt).toLocaleString() : "n/a"}
                  </div>
                ) : null}
                {job.locked ? (
                  <div className="moh-policy-hint-badge">Two-person control: unlock requires different reviewer.</div>
                ) : null}
                {job.unlockedAt ? (
                  <div className="queue-meta">
                    Unlocked by: {job.unlockedBy || "n/a"} | Unlocked at:{" "}
                    {new Date(job.unlockedAt).toLocaleString()}
                    {job.unlockReason ? ` | Reason: ${job.unlockReason}` : ""}
                  </div>
                ) : null}
                {job.unlockSignatureHash ? <div className="queue-meta">Unlock signed hash: {job.unlockSignatureHash}</div> : null}
              </div>
              <div className="queue-actions">
                <label>
                  Approval reason
                  <input
                    value={approvalReasonByJobId[job.id] || ""}
                    onChange={(event) =>
                      setApprovalReasonByJobId((current) => ({
                        ...current,
                        [job.id]: event.target.value,
                      }))
                    }
                    placeholder="Why approved/rejected"
                    disabled={Boolean(job.locked)}
                  />
                </label>
                <button
                  className="primary"
                  type="button"
                  onClick={() => decideExportJob(job, "approved")}
                  disabled={!mohPermissions.canApproveExport || Boolean(job.locked) || Boolean(decidingExportJobById[job.id])}
                  title={!mohPermissions.canApproveExport ? "Supervisor role required" : ""}
                >
                  {decidingExportJobById[job.id] === "approved" ? "Approving..." : "Approve + lock"}
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => decideExportJob(job, "rejected")}
                  disabled={!mohPermissions.canApproveExport || Boolean(job.locked) || Boolean(decidingExportJobById[job.id])}
                  title={!mohPermissions.canApproveExport ? "Supervisor role required" : ""}
                >
                  {decidingExportJobById[job.id] === "rejected" ? "Rejecting..." : "Reject + lock"}
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => downloadExportJob(job)}
                  disabled={!mohPermissions.canDownloadExport || downloadingJobId === job.id}
                  title={!mohPermissions.canDownloadExport ? "Auditor or supervisor role required" : ""}
                >
                  {downloadingJobId === job.id ? "Downloading..." : "Download"}
                </button>
                {job.locked && mohPermissions.canUnlockExport ? (
                  <button className="ghost" type="button" onClick={() => openUnlockModal(job)}>
                    Unlock (second review)
                  </button>
                ) : null}
              </div>
            </article>
          ))}
          {!exportJobs.length ? <p className="notice">No export jobs yet.</p> : null}
        </div>
      </div>

      {unlockModalJob ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal moh-unlock-modal" role="dialog" aria-modal="true" aria-labelledby="mohUnlockTitle">
            <div className="modal-header">
              <h3 id="mohUnlockTitle">Unlock Export Job (Second Review)</h3>
              <button className="ghost" type="button" onClick={closeUnlockModal}>
                Close
              </button>
            </div>
            <div className="modal-body">
              <p className="notice">
                Job: {unlockModalJob.id}
                <br />
                Locked by: {unlockModalJob.lockedBy || "n/a"}
                <br />
                Locked at: {unlockModalJob.lockedAt ? new Date(unlockModalJob.lockedAt).toLocaleString() : "n/a"}
              </p>
              <label>
                Second-review reason (required)
                <textarea
                  value={unlockReason}
                  onChange={(event) => setUnlockReason(event.target.value)}
                  placeholder="Document policy exception and why unlock is authorized."
                  rows={4}
                />
              </label>
              <div className="form-row">
                <button className="primary" type="button" onClick={unlockExportJob} disabled={unlockingJobId === unlockModalJob.id}>
                  {unlockingJobId === unlockModalJob.id ? "Unlocking..." : "Confirm unlock"}
                </button>
                <button className="ghost" type="button" onClick={closeUnlockModal}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

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
              <span className="meta">MOH</span>
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
        errorMessage={error}
        onClose={() => setError("")}
      />
        </main>
      </div>
    </section>
  );
}

