import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { useAuth } from "../context/AuthContext.jsx";
import { apiFetch } from "../utils/api.js";

export default function PharmacyQueue() {
  const { apiBase, token, user } = useAuth();
  const PHARMACY_SECTIONS = [
    { id: "dashboard", label: "Overview" },
    { id: "queue", label: "Queue & Verify" },
    { id: "otc", label: "OTC Inventory" },
    { id: "otc_orders", label: "OTC Fulfillment" },
    { id: "operations", label: "Order Ops" },
    { id: "interventions", label: "Interventions" },
    { id: "compliance", label: "Compliance" },
    { id: "chat", label: "Chat" },
  ];
  const [pharmacyProfile, setPharmacyProfile] = useState(null);
  const [prescId, setPrescId] = useState("");
  const [qrContent, setQrContent] = useState("");
  const [orderId, setOrderId] = useState("");
  const [nhfClaimDraft, setNhfClaimDraft] = useState({
    patientNhfId: "",
    baseAmount: 0,
    coveragePercent: 70,
    coverageCap: 0,
    deductible: 0,
    alreadyPaid: 0,
  });
  const [queueStatusFilter, setQueueStatusFilter] = useState("");
  const [queueSearch, setQueueSearch] = useState("");
  const [otcInventory, setOtcInventory] = useState([]);
  const [otcDraftByProductId, setOtcDraftByProductId] = useState({});
  const [otcImportFileName, setOtcImportFileName] = useState("");
  const [otcImportCsvText, setOtcImportCsvText] = useState("");
  const [otcImportDryRun, setOtcImportDryRun] = useState(true);
  const [otcImporting, setOtcImporting] = useState(false);
  const [otcImportResult, setOtcImportResult] = useState(null);
  const [otcOrders, setOtcOrders] = useState([]);
  const [otcOrderStatusFilter, setOtcOrderStatusFilter] = useState("");
  const [otcPackingStatusFilter, setOtcPackingStatusFilter] = useState("");
  const [otcOrderSearch, setOtcOrderSearch] = useState("");
  const [otcPackingNoteByOrderId, setOtcPackingNoteByOrderId] = useState({});
  const [queueFocusFilter, setQueueFocusFilter] = useState("all");
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [refreshingNow, setRefreshingNow] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [queueOrders, setQueueOrders] = useState([]);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [statusValue, setStatusValue] = useState("processing");
  const [verificationNonce, setVerificationNonce] = useState("");
  const [dispenseTokenInput, setDispenseTokenInput] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [controlledChecklist, setControlledChecklist] = useState("");
  const [useControlledOverride, setUseControlledOverride] = useState(false);
  const [controlledOverride, setControlledOverride] = useState({
    primarySignerId: "",
    secondarySignerId: "",
    justification: "",
    secondaryAuthCode: "",
  });
  const [interventionForm, setInterventionForm] = useState({
    doctorId: "",
    patientId: "",
    orderId: "",
    interventionType: "stock_issue",
    severity: "moderate",
    details: "",
    suggestedAlternative: "",
  });
  const [interventions, setInterventions] = useState([]);
  const [complianceEvents, setComplianceEvents] = useState([]);
  const [complianceRiskFilter, setComplianceRiskFilter] = useState("");
  const [complianceAckFilter, setComplianceAckFilter] = useState("all");
  const [complianceSnapshots, setComplianceSnapshots] = useState([]);
  const [snapshotLabel, setSnapshotLabel] = useState("Compliance Snapshot");
  const [snapshotIntegrityById, setSnapshotIntegrityById] = useState({});
  const [snapshotSubmissionNoteById, setSnapshotSubmissionNoteById] = useState({});
  const [snapshotEvidenceById, setSnapshotEvidenceById] = useState({});
  const [escalationReasonById, setEscalationReasonById] = useState({});
  const [verifiedPrescription, setVerifiedPrescription] = useState(null);
  const [scanStatus, setScanStatus] = useState("");
  const [message, setMessage] = useState("");
  const [doctorChatId, setDoctorChatId] = useState("");
  const [chatThreads, setChatThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState("");
  const [threadMessages, setThreadMessages] = useState([]);
  const [chatDraft, setChatDraft] = useState("");
  const [activeSection, setActiveSection] = useState("dashboard");
  const [error, setError] = useState("");
  const scannerRef = useRef(null);
  const controlsRef = useRef(null);
  const videoRef = useRef(null);

  const minutesSince = (value) => {
    const time = new Date(value || "").getTime();
    if (!Number.isFinite(time)) return 0;
    return Math.max(0, Math.floor((Date.now() - time) / 60000));
  };

  const getComplianceRisk = (eventType) => {
    const key = String(eventType || "").toLowerCase();
    if (key.includes("controlled_override")) {
      return { level: "critical", label: "Critical Risk" };
    }
    if (key.includes("controlled_checklist") || key.includes("verification_nonce_used")) {
      return { level: "high", label: "High Risk" };
    }
    if (key.includes("status_transition")) {
      return { level: "moderate", label: "Moderate Risk" };
    }
    if (key.includes("verification_nonce_issued")) {
      return { level: "low", label: "Low Risk" };
    }
    return { level: "moderate", label: "Moderate Risk" };
  };

  const queueMetrics = useMemo(() => {
    const metrics = {
      total: queueOrders.length,
      submitted: 0,
      processing: 0,
      ready: 0,
      assigned: 0,
      completed: 0,
      failed: 0,
      avgOpenMinutes: 0,
    };
    let openSum = 0;
    let openCount = 0;
    for (const order of queueOrders) {
      const key = String(order.orderStatus || "").toLowerCase();
      if (metrics[key] !== undefined) metrics[key] += 1;
      if (!["completed", "failed"].includes(key)) {
        openCount += 1;
        openSum += minutesSince(order.createdAt);
      }
    }
    metrics.avgOpenMinutes = openCount ? Math.round(openSum / openCount) : 0;
    return metrics;
  }, [queueOrders]);

  const queueFocusCounts = useMemo(() => {
    const counts = {
      all: queueOrders.length,
      sla_breach: 0,
      controlled: 0,
      unverified: 0,
      ready: 0,
    };
    for (const order of queueOrders) {
      const openMinutes = minutesSince(order.createdAt);
      const status = String(order.orderStatus || "").toLowerCase();
      if (openMinutes > 60) counts.sla_breach += 1;
      if (Boolean(order.hasControlledDrug)) counts.controlled += 1;
      if (String(order.verificationStatus || "").toLowerCase() !== "verified") counts.unverified += 1;
      if (status === "ready") counts.ready += 1;
    }
    return counts;
  }, [queueOrders]);

  const focusedQueueOrders = useMemo(() => {
    if (queueFocusFilter === "all") return queueOrders;
    return queueOrders.filter((order) => {
      const openMinutes = minutesSince(order.createdAt);
      const status = String(order.orderStatus || "").toLowerCase();
      if (queueFocusFilter === "sla_breach") return openMinutes > 60;
      if (queueFocusFilter === "controlled") return Boolean(order.hasControlledDrug);
      if (queueFocusFilter === "unverified") {
        return String(order.verificationStatus || "").toLowerCase() !== "verified";
      }
      if (queueFocusFilter === "ready") return status === "ready";
      return true;
    });
  }, [queueOrders, queueFocusFilter]);

  const getQueueUrgency = (order) => {
    const openMinutes = minutesSince(order.createdAt);
    if (openMinutes > 60) return { level: "red", label: "SLA Breach" };
    if (openMinutes > 30) return { level: "amber", label: "SLA Watch" };
    return { level: "green", label: "On track" };
  };

  const getPrescriptionMeds = (order) => {
    const meds = Array.isArray(order?.prescriptionSnapshot?.meds)
      ? order.prescriptionSnapshot.meds
      : [];
    return meds.filter((entry) => entry && (entry.name || entry.ndcCode));
  };

  const formatMedSummary = (med) => {
    const name = String(med?.name || med?.ndcCode || "Medication").trim();
    const strength = String(med?.strength || "").trim();
    const qty = Number(med?.qty);
    const dosage = String(med?.dosage || med?.dose || med?.sig || "").trim();
    const usedFor = String(med?.usedFor || "").trim();
    const parts = [name];
    if (strength) parts.push(strength);
    if (Number.isFinite(qty) && qty > 0) parts.push(`x${qty}`);
    if (dosage) parts.push(dosage);
    if (usedFor) parts.push(`for ${usedFor}`);
    return parts.join(" | ");
  };

  const selectQueueOrder = (entry) => {
    if (!entry) return;
    setSelectedOrder(entry);
    setOrderId(entry.id);
    setVerificationNonce(entry.verificationNonce || "");
    setInterventionForm((current) => ({
      ...current,
      orderId: entry.id,
      doctorId: entry?.prescriptionSnapshot?.doctorId || current.doctorId,
      patientId: entry.patientId || current.patientId,
    }));
  };

  const priorityWeight = (entry) => {
    const status = String(entry.orderStatus || "").toLowerCase();
    const openMinutes = minutesSince(entry.createdAt);
    let weight = 0;
    if (openMinutes > 60) weight += 1000;
    else if (openMinutes > 30) weight += 700;
    if (entry.hasControlledDrug) weight += 300;
    if (status === "ready") weight += 220;
    if (String(entry.verificationStatus || "").toLowerCase() !== "verified") weight += 120;
    return weight + Math.min(openMinutes, 180);
  };

  const takeNextUrgentOrder = () => {
    if (!focusedQueueOrders.length) {
      setError("No queue orders available in current filters.");
      return;
    }
    const ranked = [...focusedQueueOrders].sort((a, b) => {
      const diff = priorityWeight(b) - priorityWeight(a);
      if (diff !== 0) return diff;
      return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
    });
    selectQueueOrder(ranked[0]);
    setMessage(`Selected next urgent order: ${ranked[0].id}`);
  };

  const complianceSummary = useMemo(() => {
    const summary = { total: 0, unread: 0, low: 0, moderate: 0, high: 0, critical: 0 };
    for (const event of complianceEvents) {
      summary.total += 1;
      if (!event.acknowledged) summary.unread += 1;
      const level = String(event.riskLevel || "moderate").toLowerCase();
      if (summary[level] !== undefined) summary[level] += 1;
    }
    return summary;
  }, [complianceEvents]);

  const taskInbox = useMemo(() => {
    const pendingInterventions = interventions.filter((entry) =>
      ["pending", "pending_doctor_ack"].includes(String(entry.status || "").toLowerCase())
    ).length;
    const highRiskUnread = complianceEvents.filter(
      (event) =>
        !event.acknowledged &&
        ["high", "critical"].includes(String(event.riskLevel || "").toLowerCase())
    ).length;
    const submittedToMoh = complianceSnapshots.filter(
      (snapshot) => String(snapshot?.mohSubmission?.status || "").toLowerCase() === "submitted"
    ).length;
    return {
      pendingInterventions,
      highRiskUnread,
      submittedToMoh,
    };
  }, [interventions, complianceEvents, complianceSnapshots]);

  const filteredComplianceEvents = useMemo(() => {
    return complianceEvents.filter((event) => {
      const riskMatch = complianceRiskFilter
        ? String(event.riskLevel || "").toLowerCase() === complianceRiskFilter
        : true;
      const ackMatch =
        complianceAckFilter === "all"
          ? true
          : complianceAckFilter === "read"
            ? Boolean(event.acknowledged)
            : !event.acknowledged;
      return riskMatch && ackMatch;
    });
  }, [complianceEvents, complianceRiskFilter, complianceAckFilter]);

  const sectionBadgeCounts = useMemo(
    () => ({
      dashboard: queueMetrics.total,
      queue: focusedQueueOrders.length,
      otc: otcInventory.filter((entry) => Boolean(entry.isListed)).length,
      otc_orders: otcOrders.filter((entry) => String(entry.otcPackingStatus || "pending") !== "packed").length,
      operations: selectedOrder ? 1 : 0,
      interventions: taskInbox.pendingInterventions,
      compliance: complianceSummary.unread,
      chat: chatThreads.length,
    }),
    [
      queueMetrics.total,
      focusedQueueOrders.length,
      otcInventory,
      otcOrders,
      selectedOrder,
      taskInbox.pendingInterventions,
      complianceSummary.unread,
      chatThreads.length,
    ]
  );

  const getSeverityClass = (value, { amberAt, redAt }) => {
    const count = Number(value || 0);
    if (count >= redAt) return "pharmacy-task-inbox__card--red";
    if (count >= amberAt) return "pharmacy-task-inbox__card--amber";
    return "pharmacy-task-inbox__card--green";
  };

  const stopScan = () => {
    if (controlsRef.current) {
      controlsRef.current.stop();
      controlsRef.current = null;
    }
    setScanStatus("Scanner stopped");
  };

  const startScan = async () => {
    setError("");
    setScanStatus("Starting camera...");
    try {
      if (!scannerRef.current) {
        scannerRef.current = new BrowserMultiFormatReader();
      }
      const controls = await scannerRef.current.decodeFromVideoDevice(
        undefined,
        videoRef.current,
        (result, decodeError, localControls) => {
          controlsRef.current = localControls;
          if (result) {
            const raw = result.getText();
            setQrContent(raw);
            setScanStatus("QR captured");
            localControls.stop();
            controlsRef.current = null;
          } else if (decodeError) {
            setScanStatus("Scanning...");
          }
        }
      );
      controlsRef.current = controls;
      setScanStatus("Scanning...");
    } catch (err) {
      setError(err.message);
      setScanStatus("");
    }
  };

  const verify = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/pharmacy/verify-prescription",
        method: "POST",
        body: qrContent ? { qrContent, orderId: orderId || undefined } : { prescId, orderId: orderId || undefined },
      });
      setMessage(`Prescription verified: ${data.verified} (${data.prescription.id})`);
      setPrescId(data.prescription.id);
      setVerifiedPrescription(data.prescription);
      if (data.verificationNonce) setVerificationNonce(data.verificationNonce);
      if (data.order?.id) {
        setSelectedOrder(data.order);
        setOrderId(data.order.id);
        if (data.order?.verificationNonce) {
          setVerificationNonce(data.order.verificationNonce);
        }
      }
      await loadQueueOrders();
    } catch (err) {
      setError(err.message);
    }
  };

  const updateStatus = async () => {
    try {
      const key = idempotencyKey.trim() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/pharmacy/orders/${orderId}/status`,
        method: "POST",
        body: {
          status: statusValue,
          idempotencyKey: key,
          verificationNonce: verificationNonce.trim() || undefined,
          dispenseToken: dispenseTokenInput.trim() || undefined,
          controlledChecklist: controlledChecklist.trim() || undefined,
          useControlledOverride,
          controlledOverride: useControlledOverride
            ? {
                primarySignerId: controlledOverride.primarySignerId || user?.id || "",
                secondarySignerId: controlledOverride.secondarySignerId,
                justification: controlledOverride.justification,
                secondaryAuthCode: controlledOverride.secondaryAuthCode,
              }
            : undefined,
        },
      });
      setMessage(`Order status: ${data.order.orderStatus}${data.idempotent ? " (idempotent)" : ""}`);
      setIdempotencyKey(key);
      setSelectedOrder(data.order || null);
      await loadQueueOrders();
      await loadComplianceEvents();
    } catch (err) {
      setError(err.message);
    }
  };

  const submitNhfClaimFromPharmacy = async () => {
    try {
      if (!orderId) {
        setError("Order ID is required for NHF claim submission.");
        return;
      }
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/claims/pharmacy-submit",
        method: "POST",
        body: {
          orderId,
          patientNhfId: nhfClaimDraft.patientNhfId || null,
          baseAmount: Number(nhfClaimDraft.baseAmount || 0),
          coveragePercent: Number(nhfClaimDraft.coveragePercent || 0),
          coverageCap: Number(nhfClaimDraft.coverageCap || 0),
          deductible: Number(nhfClaimDraft.deductible || 0),
          alreadyPaid: Number(nhfClaimDraft.alreadyPaid || 0),
        },
      });
      setMessage(
        `NHF claim submitted${data.idempotent ? " (already existed)" : ""}: ${data.claim.id} | Covered: JMD ${Number(
          data.claim.amountCovered || 0
        ).toFixed(2)}`
      );
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const loadQueueOrders = async () => {
    try {
      const params = new URLSearchParams();
      if (queueStatusFilter) params.set("status", queueStatusFilter);
      if (queueSearch.trim()) params.set("query", queueSearch.trim());
      params.set("orderType", "prescription");
      const query = params.toString() ? `?${params.toString()}` : "";
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/pharmacy/orders/queue${query}`,
      });
      setQueueOrders(data.orders || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadOtcInventory = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/pharmacy/otc/inventory",
      });
      const items = data.items || [];
      setOtcInventory(items);
      setOtcDraftByProductId(() => {
        const next = {};
        for (const item of items) {
          const key = String(item.productId || "");
          if (!key) continue;
          next[key] = {
            onHand: Number(item.onHand || 0),
            unitPrice: Number(item.unitPrice || 0),
            maxPerOrder: Number(item.maxPerOrder || item.defaultMaxQtyPerOrder || 1),
            isListed: Boolean(item.isListed),
          };
        }
        return next;
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const loadOtcOrders = async () => {
    try {
      const params = new URLSearchParams();
      if (otcOrderStatusFilter) params.set("status", otcOrderStatusFilter);
      if (otcPackingStatusFilter) params.set("packingStatus", otcPackingStatusFilter);
      if (otcOrderSearch.trim()) params.set("query", otcOrderSearch.trim());
      const query = params.toString() ? `?${params.toString()}` : "";
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/pharmacy/otc/orders${query}`,
      });
      setOtcOrders(data.orders || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const updateOtcPackingStatus = async (orderId, packingStatus) => {
    try {
      const note = String(otcPackingNoteByOrderId[orderId] || "").trim();
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/pharmacy/otc/orders/${orderId}/packing`,
        method: "POST",
        body: {
          packingStatus,
          note: note || undefined,
        },
      });
      setMessage(`OTC order ${data.order.id} updated to packing status '${data.order.otcPackingStatus || packingStatus}'.`);
      await Promise.all([loadOtcOrders(), loadQueueOrders()]);
    } catch (err) {
      setError(err.message);
    }
  };

  const saveOtcInventoryRow = async (productId) => {
    try {
      const key = String(productId || "");
      const draft = otcDraftByProductId[key];
      if (!draft) {
        setError("No OTC draft row to save.");
        return;
      }
      await apiFetch({
        apiBase,
        token,
        path: "/api/pharmacy/otc/inventory/upsert",
        method: "POST",
        body: {
          productId: key,
          onHand: Number(draft.onHand || 0),
          unitPrice: Number(draft.unitPrice || 0),
          maxPerOrder: Number(draft.maxPerOrder || 1),
          isListed: draft.isListed === true,
        },
      });
      setMessage("OTC inventory saved.");
      await loadOtcInventory();
    } catch (err) {
      setError(err.message);
    }
  };

  const onOtcCsvSelected = async (event) => {
    try {
      const file = event?.target?.files?.[0];
      if (!file) {
        setOtcImportFileName("");
        setOtcImportCsvText("");
        return;
      }
      const text = await file.text();
      setOtcImportFileName(file.name || "otc-inventory.csv");
      setOtcImportCsvText(text || "");
      setOtcImportResult(null);
      setMessage(`Loaded CSV file: ${file.name}`);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      if (event?.target) event.target.value = "";
    }
  };

  const importOtcInventoryCsv = async () => {
    try {
      if (!otcImportCsvText.trim()) {
        setError("Select a CSV file first.");
        return;
      }
      setOtcImporting(true);
      setError("");
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/pharmacy/otc/inventory/import-csv",
        method: "POST",
        body: {
          csvText: otcImportCsvText,
          dryRun: otcImportDryRun,
        },
      });
      setOtcImportResult(data);
      const summary = data?.summary || {};
      setMessage(
        `OTC CSV import ${summary.dryRun ? "(dry run) " : ""}completed: imported ${Number(
          summary.imported || 0
        )}, failed ${Number(summary.failed || 0)}.`
      );
      if (!otcImportDryRun && Number(summary.imported || 0) > 0) {
        await loadOtcInventory();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setOtcImporting(false);
    }
  };

  const loadPharmacyProfile = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/pharmacy/profile/me",
      });
      setPharmacyProfile(data.profile || null);
    } catch (_err) {
      // Keep the queue usable even if profile metadata is unavailable.
      setPharmacyProfile(null);
    }
  };

  const loadInterventions = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/pharmacy/interventions",
      });
      setInterventions(data.interventions || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadComplianceEvents = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/pharmacy/compliance-events",
      });
      setComplianceEvents(data.events || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadComplianceSnapshots = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/pharmacy/compliance-events/snapshots",
      });
      setComplianceSnapshots(data.snapshots || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const downloadFromPath = async ({ path, filename, contentType }) => {
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
    const normalized = contentType ? blob.slice(0, blob.size, contentType) : blob;
    const url = URL.createObjectURL(normalized);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const exportCurrentComplianceCsv = async () => {
    try {
      const params = new URLSearchParams();
      if (complianceRiskFilter) params.set("risk", complianceRiskFilter);
      if (complianceAckFilter && complianceAckFilter !== "all") params.set("ack", complianceAckFilter);
      const query = params.toString() ? `?${params.toString()}` : "";
      await downloadFromPath({
        path: `/api/pharmacy/compliance-events/export.csv${query}`,
        filename: `pharmacy-compliance-${new Date().toISOString().slice(0, 10)}.csv`,
        contentType: "text/csv;charset=utf-8",
      });
      setMessage("Compliance CSV export downloaded.");
    } catch (err) {
      setError(err.message);
    }
  };

  const createComplianceSnapshot = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/pharmacy/compliance-events/snapshots",
        method: "POST",
        body: {
          label: snapshotLabel.trim() || "Compliance Snapshot",
          filters: {
            risk: complianceRiskFilter || undefined,
            ack: complianceAckFilter || undefined,
          },
        },
      });
      setMessage(`Snapshot created: ${data.snapshot?.id || "ok"}`);
      await loadComplianceSnapshots();
    } catch (err) {
      setError(err.message);
    }
  };

  const downloadSnapshotCsv = async (snapshotId) => {
    try {
      await downloadFromPath({
        path: `/api/pharmacy/compliance-events/snapshots/${snapshotId}/export.csv`,
        filename: `compliance-snapshot-${snapshotId}.csv`,
        contentType: "text/csv;charset=utf-8",
      });
      setMessage("Snapshot CSV downloaded.");
    } catch (err) {
      setError(err.message);
    }
  };

  const openSnapshotPrintView = async (snapshotId) => {
    try {
      const response = await fetch(`${apiBase}/api/pharmacy/compliance-events/snapshots/${snapshotId}/print`, {
        method: "GET",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `${response.status} ${response.statusText}`);
      }
      const html = await response.text();
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    } catch (err) {
      setError(err.message);
    }
  };

  const verifySnapshotIntegrity = async (snapshotId) => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/pharmacy/compliance-events/snapshots/${snapshotId}/verify`,
      });
      setSnapshotIntegrityById((current) => ({
        ...current,
        [snapshotId]: {
          integrityOk: Boolean(data.integrityOk),
          signatureOk: Boolean(data.signatureOk),
          chainOk: Boolean(data.chainOk),
          overallValid: Boolean(data.overallValid),
          verifiedAt: data.verifiedAt || new Date().toISOString(),
        },
      }));
      setMessage(
        data.overallValid
          ? `Snapshot ${snapshotId} cryptographic validation passed.`
          : `Snapshot ${snapshotId} validation failed (integrity/signature/chain).`
      );
    } catch (err) {
      setError(err.message);
    }
  };

  const submitSnapshotToMoh = async (snapshotId) => {
    try {
      const note = String(snapshotSubmissionNoteById[snapshotId] || "").trim();
      const evidence = Array.isArray(snapshotEvidenceById[snapshotId]) ? snapshotEvidenceById[snapshotId] : [];
      await apiFetch({
        apiBase,
        token,
        path: `/api/pharmacy/compliance-events/snapshots/${snapshotId}/submit-moh`,
        method: "POST",
        body: {
          note: note || undefined,
          evidence: evidence.length ? evidence : undefined,
        },
      });
      setMessage("Snapshot submitted to MOH review queue.");
      setSnapshotEvidenceById((current) => ({ ...current, [snapshotId]: [] }));
      await loadComplianceSnapshots();
    } catch (err) {
      setError(err.message);
    }
  };

  const addSnapshotEvidenceFiles = (snapshotId, fileList) => {
    const files = Array.from(fileList || []).slice(0, 3);
    if (!files.length) return;
    Promise.all(
      files.map(
        (file) =>
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                name: file.name,
                mimeType: file.type || "application/octet-stream",
                bytes: Number(file.size || 0),
                dataUrl: String(reader.result || ""),
              });
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
          })
      )
    ).then((items) => {
      const clean = items.filter((entry) => entry && entry.dataUrl);
      setSnapshotEvidenceById((current) => ({
        ...current,
        [snapshotId]: [...(current[snapshotId] || []), ...clean].slice(0, 4),
      }));
    });
  };

  const markComplianceEventRead = async (event) => {
    if (!event?.id || !event?.orderId || event.acknowledged) return;
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/pharmacy/orders/${event.orderId}/compliance-events/${event.id}/ack`,
        method: "POST",
        body: {},
      });
      setMessage("Compliance event marked as reviewed.");
      await loadComplianceEvents();
    } catch (err) {
      setError(err.message);
    }
  };

  const createIntervention = async () => {
    try {
      const body = {
        ...interventionForm,
      };
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/pharmacy/interventions",
        method: "POST",
        body,
      });
      setMessage(`Intervention created: ${data.intervention?.id || "ok"}`);
      setInterventionForm((current) => ({
        ...current,
        details: "",
        suggestedAlternative: "",
      }));
      await loadInterventions();
    } catch (err) {
      setError(err.message);
    }
  };

  const escalateIntervention = async (intervention) => {
    const reason = String(escalationReasonById[intervention.id] || "").trim();
    if (!reason) {
      setError("Enter escalation reason before escalating intervention.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/pharmacy/interventions/${intervention.id}/escalate`,
        method: "POST",
        body: {
          reason,
          severity: intervention.severity || "high",
        },
      });
      setMessage("Intervention escalated to doctor acknowledgement queue.");
      setEscalationReasonById((current) => ({ ...current, [intervention.id]: "" }));
      await loadInterventions();
    } catch (err) {
      setError(err.message);
    }
  };

  const loadChatThreads = async () => {
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/chat/threads" });
      setChatThreads(data.threads || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const openDoctorChat = async () => {
    if (!doctorChatId) {
      setError("Enter a doctor ID.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/chat/threads",
        method: "POST",
        body: { doctorId: doctorChatId },
      });
      if (data.thread?.id) {
        setActiveThreadId(data.thread.id);
        await loadChatThreads();
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const loadThreadMessages = async (threadId) => {
    if (!threadId) return;
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/chat/threads/${threadId}/messages`,
      });
      setThreadMessages(data.messages || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const sendChatMessage = async () => {
    const content = chatDraft.trim();
    if (!activeThreadId || !content) return;
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/chat/threads/${activeThreadId}/messages`,
        method: "POST",
        body: { message: content },
      });
      setChatDraft("");
      await loadThreadMessages(activeThreadId);
    } catch (err) {
      setError(err.message);
    }
  };

  const refreshOperationalData = async ({ silent = false } = {}) => {
    try {
      if (!silent) setRefreshingNow(true);
      const results = await Promise.allSettled([
        loadChatThreads(),
        loadQueueOrders(),
        loadOtcInventory(),
        loadOtcOrders(),
        loadInterventions(),
        loadComplianceEvents(),
        loadComplianceSnapshots(),
      ]);
      const firstRejected = results.find((entry) => entry.status === "rejected");
      if (firstRejected?.reason?.message) {
        setError(firstRejected.reason.message);
      }
      setLastRefreshedAt(new Date().toISOString());
    } finally {
      if (!silent) setRefreshingNow(false);
    }
  };

  useEffect(
    () => () => {
      stopScan();
    },
    []
  );

  useEffect(() => {
    loadPharmacyProfile();
    refreshOperationalData({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoRefreshEnabled) return undefined;
    const intervalId = window.setInterval(() => {
      refreshOperationalData({ silent: true });
    }, 30000);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoRefreshEnabled,
    queueStatusFilter,
    queueSearch,
    otcOrderStatusFilter,
    otcPackingStatusFilter,
    otcOrderSearch,
    complianceRiskFilter,
    complianceAckFilter,
    queueFocusFilter,
  ]);

  useEffect(() => {
    if (activeThreadId) {
      loadThreadMessages(activeThreadId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  return (
    <section className="panel doctor-shell">
      <h2>Pharmacy Queue</h2>
      <div className="doctor-workspace pharmacy-workspace">
        <aside className="doctor-sidebar pharmacy-sidebar">
          <div className="doctor-sidebar-title">Pharmacy Sections</div>
          <nav className="doctor-sidebar-nav" aria-label="Pharmacy sections">
            {PHARMACY_SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`doctor-sidebar-link${activeSection === section.id ? " active" : ""}`}
                onClick={() => setActiveSection(section.id)}
              >
                <span>{section.label}</span>
                {Number(sectionBadgeCounts[section.id] || 0) > 0 ? (
                  <span className="doctor-module-badge">
                    {Number(sectionBadgeCounts[section.id]) > 99 ? "99+" : Number(sectionBadgeCounts[section.id])}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>
        </aside>
        <div className="doctor-main pharmacy-main" data-active-module={activeSection}>
      {activeSection === "dashboard" ? (
      <>
      <div className="pharmacy-identity">
        <span className="pharmacy-identity__label">Pharmacy Identity</span>
        <span className="pharmacy-identity__value">
          {pharmacyProfile?.registeredName || user?.fullName || "Pharmacy"}
        </span>
        <span className="pharmacy-identity__meta">
          Reg code: {pharmacyProfile?.councilReg || "Not registered"}
        </span>
      </div>
      <div className="pharmacy-task-inbox">
        <div className="pharmacy-task-inbox__title">Pharmacy Task Inbox</div>
        <div className="pharmacy-task-inbox__grid">
          <button
            className={`pharmacy-task-inbox__card ${getSeverityClass(taskInbox.pendingInterventions, {
              amberAt: 2,
              redAt: 5,
            })}`}
            type="button"
            onClick={() => setActiveSection("interventions")}
          >
            <span className="pharmacy-task-inbox__count">{taskInbox.pendingInterventions}</span>
            <span className="pharmacy-task-inbox__label">Pending interventions</span>
          </button>
          <button
            className={`pharmacy-task-inbox__card ${getSeverityClass(taskInbox.highRiskUnread, {
              amberAt: 1,
              redAt: 3,
            })}`}
            type="button"
            onClick={() => setActiveSection("compliance")}
          >
            <span className="pharmacy-task-inbox__count">{taskInbox.highRiskUnread}</span>
            <span className="pharmacy-task-inbox__label">High-risk unread events</span>
          </button>
          <button
            className={`pharmacy-task-inbox__card ${getSeverityClass(taskInbox.submittedToMoh, {
              amberAt: 2,
              redAt: 4,
            })}`}
            type="button"
            onClick={() => setActiveSection("compliance")}
          >
            <span className="pharmacy-task-inbox__count">{taskInbox.submittedToMoh}</span>
            <span className="pharmacy-task-inbox__label">MOH submissions pending</span>
          </button>
        </div>
      </div>
      <div className="notice">Use the left sidebar to open queue, operations, interventions, compliance, and chat.</div>
      </>
      ) : null}
      {activeSection === "queue" ? (
      <>
      <div className="form">
        <div className="form-row">
          <label>
            Queue status
            <select value={queueStatusFilter} onChange={(e) => setQueueStatusFilter(e.target.value)}>
              <option value="">All</option>
              {["submitted", "processing", "ready", "assigned", "completed", "failed"].map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label>
            Queue search
            <input
              value={queueSearch}
              onChange={(e) => setQueueSearch(e.target.value)}
              placeholder="Order ID / Patient / Prescription"
            />
          </label>
          <button className="ghost" type="button" onClick={() => refreshOperationalData()} disabled={refreshingNow}>
            {refreshingNow ? "Refreshing..." : "Refresh queue"}
          </button>
          <button className="primary" type="button" onClick={takeNextUrgentOrder} disabled={!focusedQueueOrders.length}>
            Take next urgent
          </button>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoRefreshEnabled}
              onChange={(e) => setAutoRefreshEnabled(Boolean(e.target.checked))}
            />
            Auto-refresh 30s
          </label>
        </div>
        <div className="pharmacy-focus-bar">
          <button
            type="button"
            className={`pharmacy-focus-chip ${queueFocusFilter === "all" ? "active" : ""}`}
            onClick={() => setQueueFocusFilter("all")}
          >
            All ({queueFocusCounts.all})
          </button>
          <button
            type="button"
            className={`pharmacy-focus-chip ${queueFocusFilter === "sla_breach" ? "active" : ""}`}
            onClick={() => setQueueFocusFilter("sla_breach")}
          >
            SLA Breach ({queueFocusCounts.sla_breach})
          </button>
          <button
            type="button"
            className={`pharmacy-focus-chip ${queueFocusFilter === "controlled" ? "active" : ""}`}
            onClick={() => setQueueFocusFilter("controlled")}
          >
            Controlled ({queueFocusCounts.controlled})
          </button>
          <button
            type="button"
            className={`pharmacy-focus-chip ${queueFocusFilter === "unverified" ? "active" : ""}`}
            onClick={() => setQueueFocusFilter("unverified")}
          >
            Unverified ({queueFocusCounts.unverified})
          </button>
          <button
            type="button"
            className={`pharmacy-focus-chip ${queueFocusFilter === "ready" ? "active" : ""}`}
            onClick={() => setQueueFocusFilter("ready")}
          >
            Ready ({queueFocusCounts.ready})
          </button>
        </div>
        <div className="meta">
          Last sync: {lastRefreshedAt ? new Date(lastRefreshedAt).toLocaleTimeString() : "not yet"}
        </div>
        <div className="queue">
          {focusedQueueOrders.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={`patient-record-card ${selectedOrder?.id === entry.id ? "active" : ""}`}
              onClick={() => selectQueueOrder(entry)}
            >
              <div className="patient-record-title">
                {entry.id} | {entry.orderStatus} {entry.hasControlledDrug ? "| Controlled" : ""}
              </div>
              <div className="meta">
                {entry.patientName || entry.patientId || "Unknown patient"} | verification:{" "}
                {entry.verificationStatus || "unverified"}
              </div>
              {getPrescriptionMeds(entry).length ? (
                <div className="meta">
                  Rx: {formatMedSummary(getPrescriptionMeds(entry)[0])}
                  {getPrescriptionMeds(entry).length > 1 ? ` (+${getPrescriptionMeds(entry).length - 1} more)` : ""}
                </div>
              ) : (
                <div className="meta">Rx: No prescription details attached</div>
              )}
              <div className="meta">
                Dispatch: {entry.dispatchStatus || "none"} | Courier:{" "}
                {entry.courierName || entry.courierId || "unassigned"}
              </div>
              <div className="meta">
                ETA: {entry.dispatchEtaStart ? new Date(entry.dispatchEtaStart).toLocaleString() : "n/a"} -{" "}
                {entry.dispatchEtaEnd ? new Date(entry.dispatchEtaEnd).toLocaleString() : "n/a"}
              </div>
              <div className="meta">
                Open: {minutesSince(entry.createdAt)} min |{" "}
                <span className={`pharmacy-urgency pharmacy-urgency--${getQueueUrgency(entry).level}`}>
                  {getQueueUrgency(entry).label}
                </span>
              </div>
            </button>
          ))}
          {!focusedQueueOrders.length ? <div className="meta">No queue orders in this filter.</div> : null}
        </div>
        <div className="notice">
          Queue metrics | Total: {queueMetrics.total} | Submitted: {queueMetrics.submitted} | Processing:{" "}
          {queueMetrics.processing} | Ready: {queueMetrics.ready} | Assigned: {queueMetrics.assigned} | Completed:{" "}
          {queueMetrics.completed} | Avg open: {queueMetrics.avgOpenMinutes} min
        </div>
        <label>
          Prescription ID
          <input value={prescId} onChange={(e) => setPrescId(e.target.value)} />
        </label>
        <label>
          QR content (scan/paste)
          <textarea
            value={qrContent}
            onChange={(e) => setQrContent(e.target.value)}
            placeholder="Paste scanned QR JSON here"
          />
        </label>
        <div className="qr-scan-panel">
          <div className="qr-scan-header">
            <strong>Camera QR Scanner</strong>
            <div className="form-row">
              <button className="primary" type="button" onClick={startScan}>
                Start scan
              </button>
              <button className="ghost" type="button" onClick={stopScan}>
                Stop scan
              </button>
            </div>
          </div>
          <video ref={videoRef} className="qr-video" muted playsInline />
          {scanStatus ? <div className="meta">{scanStatus}</div> : null}
        </div>
        <button className="primary" onClick={verify}>
          Verify prescription
        </button>
      </div>
      {verifiedPrescription ? (
        <div className="notice">
          <strong>Prescription Details</strong>
          <br />
          ID: {verifiedPrescription.id}
          <br />
          Doctor: {verifiedPrescription.doctorName || "N/A"} (
          {verifiedPrescription.doctorId || "N/A"})
          <br />
          Patient: {verifiedPrescription.patientFullName || "N/A"}
          <br />
          Refill amount: {Number(verifiedPrescription.allowedRefills || 0)}
          <br />
          Expiry: {verifiedPrescription.expiryDate || "N/A"}
          <br />
          Meds:{" "}
          {(verifiedPrescription.meds || [])
            .map((med) => `${med.name} ${med.strength} x${med.qty}`)
            .join(", ")}
        </div>
      ) : null}
      </>
      ) : null}
      {activeSection === "chat" ? (
      <>
      <div className="pharmacy-chat-header">
        <span className="pharmacy-chat-header__title">Pharmacy Chat</span>
        <span className="pharmacy-chat-header__meta">
          {pharmacyProfile?.registeredName || user?.fullName || "Pharmacy"} | Reg:{" "}
          {pharmacyProfile?.councilReg || "Not registered"}
        </span>
      </div>
      <div className="form" id="pharmacy-interventions">
        <label>
          Doctor ID (for chat)
          <input value={doctorChatId} onChange={(e) => setDoctorChatId(e.target.value)} />
        </label>
        <button className="primary" type="button" onClick={openDoctorChat}>
          Open doctor chat
        </button>
      </div>
      <div className="queue">
        {chatThreads.map((thread) => (
          <button
            type="button"
            key={thread.id}
            className={`patient-record-card ${activeThreadId === thread.id ? "active" : ""}`}
            onClick={() => setActiveThreadId(thread.id)}
          >
            <div className="patient-record-title">
              {thread.counterpartName || thread.counterpartId || "Doctor"}
            </div>
          </button>
        ))}
      </div>
      <div className="chat-window">
        {threadMessages.map((msg) => (
          <div
            key={msg.id}
            className={`chat-bubble ${msg.senderId === user?.id ? "chat-patient" : "chat-office"}`}
          >
            <div>{msg.message}</div>
            <div className="meta">{new Date(msg.createdAt).toLocaleString()}</div>
          </div>
        ))}
      </div>
      <div className="form-row chat-form">
        <input
          value={chatDraft}
          onChange={(e) => setChatDraft(e.target.value)}
          placeholder="Type message..."
        />
        <button
          className="primary"
          type="button"
          onClick={sendChatMessage}
          disabled={!activeThreadId || !chatDraft.trim()}
        >
          Send
        </button>
      </div>
      </>
      ) : null}
      {activeSection === "otc" ? (
      <div className="form">
        <div className="form-row">
          <h3>OTC Inventory Panel</h3>
          <button className="ghost" type="button" onClick={loadOtcInventory}>
            Refresh OTC inventory
          </button>
        </div>
        <div className="form-row">
          <label>
            Bulk CSV import
            <input type="file" accept=".csv,text/csv" onChange={onOtcCsvSelected} />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={otcImportDryRun}
              onChange={(e) => setOtcImportDryRun(Boolean(e.target.checked))}
            />
            Dry run
          </label>
          <button
            className="primary"
            type="button"
            onClick={importOtcInventoryCsv}
            disabled={otcImporting || !otcImportCsvText.trim()}
          >
            {otcImporting ? "Importing..." : "Import CSV"}
          </button>
        </div>
        <div className="meta">
          {otcImportFileName
            ? `Loaded: ${otcImportFileName}`
            : "CSV columns: sku or productId, onHand, unitPrice, maxPerOrder, isListed"}
        </div>
        {otcImportResult?.summary ? (
          <div className="notice">
            Import summary | Rows: {Number(otcImportResult.summary.totalRows || 0)} | Imported:{" "}
            {Number(otcImportResult.summary.imported || 0)} | Created:{" "}
            {Number(otcImportResult.summary.created || 0)} | Updated:{" "}
            {Number(otcImportResult.summary.updated || 0)} | Failed:{" "}
            {Number(otcImportResult.summary.failed || 0)} | Skipped:{" "}
            {Number(otcImportResult.summary.skipped || 0)}
          </div>
        ) : null}
        {Array.isArray(otcImportResult?.failures) && otcImportResult.failures.length ? (
          <div className="queue-meta">
            Failed rows:{" "}
            {otcImportResult.failures
              .slice(0, 6)
              .map((entry) => `row ${entry.row}: ${entry.error}`)
              .join(" | ")}
          </div>
        ) : null}
        <div className="queue">
          {otcInventory.map((entry) => {
            const key = String(entry.productId || "");
            const draft = otcDraftByProductId[key] || {
              onHand: Number(entry.onHand || 0),
              unitPrice: Number(entry.unitPrice || 0),
              maxPerOrder: Number(entry.maxPerOrder || entry.defaultMaxQtyPerOrder || 1),
              isListed: Boolean(entry.isListed),
            };
            return (
              <article key={entry.productId} className="queue-card">
                <div>
                  <div className="queue-title">
                    {entry.name} | {entry.strength || "n/a"} | {entry.dosageForm || "n/a"}
                  </div>
                  <div className="queue-meta">
                    SKU: {entry.sku || "n/a"} | Category: {entry.category || "general"} | Ingredient:{" "}
                    {entry.activeIngredient || "n/a"}
                  </div>
                </div>
                <div className="form-row">
                  <label>
                    On hand
                    <input
                      type="number"
                      min="0"
                      value={Number(draft.onHand || 0)}
                      onChange={(e) =>
                        setOtcDraftByProductId((current) => ({
                          ...current,
                          [key]: { ...draft, onHand: Number(e.target.value || 0) },
                        }))
                      }
                    />
                  </label>
                  <label>
                    Unit price (JMD)
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={Number(draft.unitPrice || 0)}
                      onChange={(e) =>
                        setOtcDraftByProductId((current) => ({
                          ...current,
                          [key]: { ...draft, unitPrice: Number(e.target.value || 0) },
                        }))
                      }
                    />
                  </label>
                  <label>
                    Max per order
                    <input
                      type="number"
                      min="1"
                      value={Number(draft.maxPerOrder || 1)}
                      onChange={(e) =>
                        setOtcDraftByProductId((current) => ({
                          ...current,
                          [key]: { ...draft, maxPerOrder: Number(e.target.value || 1) },
                        }))
                      }
                    />
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.isListed)}
                      onChange={(e) =>
                        setOtcDraftByProductId((current) => ({
                          ...current,
                          [key]: { ...draft, isListed: Boolean(e.target.checked) },
                        }))
                      }
                    />
                    Listed
                  </label>
                  <button className="primary" type="button" onClick={() => saveOtcInventoryRow(key)}>
                    Save
                  </button>
                </div>
              </article>
            );
          })}
          {!otcInventory.length ? <div className="meta">No OTC products found.</div> : null}
        </div>
      </div>
      ) : null}
      {activeSection === "otc_orders" ? (
      <div className="form">
        <div className="form-row">
          <h3>OTC Fulfillment Queue</h3>
          <label>
            Order status
            <select value={otcOrderStatusFilter} onChange={(e) => setOtcOrderStatusFilter(e.target.value)}>
              <option value="">all</option>
              {["submitted", "processing", "ready", "assigned", "completed", "failed"].map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label>
            Packing status
            <select value={otcPackingStatusFilter} onChange={(e) => setOtcPackingStatusFilter(e.target.value)}>
              <option value="">all</option>
              {["pending", "packing", "packed"].map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label>
            Search
            <input value={otcOrderSearch} onChange={(e) => setOtcOrderSearch(e.target.value)} />
          </label>
          <button className="ghost" type="button" onClick={loadOtcOrders}>
            Refresh OTC orders
          </button>
        </div>
        <div className="queue">
          {otcOrders.map((order) => (
            <article key={order.id} className="queue-card">
              <div>
                <div className="queue-title">
                  {order.id} | {order.orderStatus || "submitted"} | Packing: {order.otcPackingStatus || "pending"}
                </div>
                <div className="queue-meta">
                  Patient: {order.patientName || order.patientId || "n/a"} | Payment: {order.paymentMethod || "n/a"} |{" "}
                  {order.paymentStatus || "n/a"}
                </div>
                <div className="queue-meta">
                  Total: JMD {Number(order?.otcSummary?.totalAmount || order?.payment?.totalAmount || 0).toFixed(2)} | Items:{" "}
                  {Number(order?.otcSummary?.itemCount || 0)}
                </div>
                <div className="queue-meta">
                  {(order.otcItems || [])
                    .map((entry) => `${entry.productName || entry.sku || "Item"} x${Number(entry.qty || 0)}`)
                    .join(" | ") || "No OTC items"}
                </div>
              </div>
              <div className="form-row">
                <input
                  value={otcPackingNoteByOrderId[order.id] || ""}
                  onChange={(e) =>
                    setOtcPackingNoteByOrderId((current) => ({ ...current, [order.id]: e.target.value }))
                  }
                  placeholder="Optional packing note"
                />
                <button
                  className="ghost"
                  type="button"
                  onClick={() => updateOtcPackingStatus(order.id, "packing")}
                  disabled={String(order.otcPackingStatus || "").toLowerCase() === "packed"}
                >
                  Start packing
                </button>
                <button
                  className="primary"
                  type="button"
                  onClick={() => updateOtcPackingStatus(order.id, "packed")}
                  disabled={String(order.otcPackingStatus || "").toLowerCase() === "packed"}
                >
                  Mark packed
                </button>
              </div>
            </article>
          ))}
          {!otcOrders.length ? <div className="meta">No OTC orders in this filter.</div> : null}
        </div>
      </div>
      ) : null}
      {activeSection === "operations" ? (
      <div className="form" id="pharmacy-compliance">
        <label>
          Order ID
          <input value={orderId} onChange={(e) => setOrderId(e.target.value)} />
        </label>
        <label>
          Patient NHF ID
          <input
            value={nhfClaimDraft.patientNhfId}
            onChange={(e) =>
              setNhfClaimDraft((current) => ({ ...current, patientNhfId: e.target.value }))
            }
          />
        </label>
        <label>
          NHF base amount
          <input
            type="number"
            value={nhfClaimDraft.baseAmount}
            onChange={(e) =>
              setNhfClaimDraft((current) => ({ ...current, baseAmount: Number(e.target.value || 0) }))
            }
            placeholder="Optional override"
          />
        </label>
        <label>
          NHF coverage %
          <input
            type="number"
            value={nhfClaimDraft.coveragePercent}
            onChange={(e) =>
              setNhfClaimDraft((current) => ({
                ...current,
                coveragePercent: Number(e.target.value || 0),
              }))
            }
          />
        </label>
        <label>
          NHF coverage cap
          <input
            type="number"
            value={nhfClaimDraft.coverageCap}
            onChange={(e) =>
              setNhfClaimDraft((current) => ({ ...current, coverageCap: Number(e.target.value || 0) }))
            }
          />
        </label>
        <label>
          Idempotency key
          <input
            value={idempotencyKey}
            onChange={(e) => setIdempotencyKey(e.target.value)}
            placeholder="Optional: stable key for retries"
          />
        </label>
        <label>
          Verification nonce (one-time)
          <input
            value={verificationNonce}
            onChange={(e) => setVerificationNonce(e.target.value)}
            placeholder="Returned by verify step"
          />
          <span className="meta">Required for strict verification on ready status and expires after TTL.</span>
        </label>
        <label>
          Status
          <select value={statusValue} onChange={(e) => setStatusValue(e.target.value)}>
            {["processing", "ready", "assigned", "completed", "failed"].map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label>
          Dispense token (required for completed)
          <input
            value={dispenseTokenInput}
            onChange={(e) => setDispenseTokenInput(e.target.value)}
            placeholder="Token from ready stage"
          />
        </label>
        <label>
          Controlled checklist confirmation
          <input
            value={controlledChecklist}
            onChange={(e) => setControlledChecklist(e.target.value)}
            placeholder="Required for controlled-drug ready transition"
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={useControlledOverride}
            onChange={(e) => setUseControlledOverride(Boolean(e.target.checked))}
          />
          Use controlled-substance dual-sign override
        </label>
        {useControlledOverride ? (
          <>
            <label>
              Primary signer ID
              <input
                value={controlledOverride.primarySignerId}
                onChange={(e) =>
                  setControlledOverride((current) => ({ ...current, primarySignerId: e.target.value }))
                }
                placeholder={user?.id || "Current pharmacist user id"}
              />
            </label>
            <label>
              Secondary signer ID
              <input
                value={controlledOverride.secondarySignerId}
                onChange={(e) =>
                  setControlledOverride((current) => ({ ...current, secondarySignerId: e.target.value }))
                }
                placeholder="Different pharmacy user id"
              />
            </label>
            <label>
              Override justification
              <textarea
                value={controlledOverride.justification}
                onChange={(e) =>
                  setControlledOverride((current) => ({ ...current, justification: e.target.value }))
                }
                placeholder="Clinical/compliance reason for override"
              />
            </label>
            <label>
              Secondary auth code (stub)
              <input
                value={controlledOverride.secondaryAuthCode}
                onChange={(e) =>
                  setControlledOverride((current) => ({ ...current, secondaryAuthCode: e.target.value }))
                }
                placeholder="6-digit code if secondary auth stub enabled"
              />
            </label>
          </>
        ) : null}
        <button className="primary" onClick={updateStatus}>
          Update order
        </button>
        <button className="ghost" type="button" onClick={submitNhfClaimFromPharmacy}>
          Submit NHF claim
        </button>
        {selectedOrder ? (
          <div className="meta">
            Dispatch: {selectedOrder.dispatchStatus || "none"} | Courier:{" "}
            {selectedOrder.courierName || selectedOrder.courierId || "unassigned"} | ETA:{" "}
            {selectedOrder.dispatchEtaStart
              ? new Date(selectedOrder.dispatchEtaStart).toLocaleString()
              : "n/a"}{" "}
            -{" "}
            {selectedOrder.dispatchEtaEnd ? new Date(selectedOrder.dispatchEtaEnd).toLocaleString() : "n/a"}
          </div>
        ) : null}
        {selectedOrder ? (
          <div className="meta">
            Prescription details:
            {getPrescriptionMeds(selectedOrder).length ? null : " none"}
          </div>
        ) : null}
        {selectedOrder
          ? getPrescriptionMeds(selectedOrder).map((med, index) => (
              <div key={`${selectedOrder.id}-med-${index}`} className="meta">
                {index + 1}. {formatMedSummary(med)}
              </div>
            ))
          : null}
        {selectedOrder?.dispatchFailureReason ? (
          <div className="meta">Dispatch issue: {selectedOrder.dispatchFailureReason}</div>
        ) : null}
        {selectedOrder?.dispenseToken ? (
          <div className="meta">Dispense token issued: {selectedOrder.dispenseToken}</div>
        ) : null}
      </div>
      ) : null}
      {activeSection === "interventions" ? (
      <div className="form">
        <h3>Pharmacy Intervention Queue</h3>
        <label>
          Doctor ID
          <input
            value={interventionForm.doctorId}
            onChange={(e) => setInterventionForm((current) => ({ ...current, doctorId: e.target.value }))}
          />
        </label>
        <label>
          Patient ID
          <input
            value={interventionForm.patientId}
            onChange={(e) => setInterventionForm((current) => ({ ...current, patientId: e.target.value }))}
          />
        </label>
        <label>
          Order ID (optional)
          <input
            value={interventionForm.orderId}
            onChange={(e) => setInterventionForm((current) => ({ ...current, orderId: e.target.value }))}
          />
        </label>
        <label>
          Intervention type
          <select
            value={interventionForm.interventionType}
            onChange={(e) =>
              setInterventionForm((current) => ({ ...current, interventionType: e.target.value }))
            }
          >
            <option value="stock_issue">stock_issue</option>
            <option value="substitution">substitution</option>
            <option value="dose_clarification">dose_clarification</option>
            <option value="allergy_concern">allergy_concern</option>
          </select>
        </label>
        <label>
          Severity
          <select
            value={interventionForm.severity}
            onChange={(e) => setInterventionForm((current) => ({ ...current, severity: e.target.value }))}
          >
            <option value="low">low</option>
            <option value="moderate">moderate</option>
            <option value="high">high</option>
            <option value="critical">critical</option>
          </select>
        </label>
        <label>
          Details
          <textarea
            value={interventionForm.details}
            onChange={(e) => setInterventionForm((current) => ({ ...current, details: e.target.value }))}
          />
        </label>
        <label>
          Suggested alternative
          <input
            value={interventionForm.suggestedAlternative}
            onChange={(e) =>
              setInterventionForm((current) => ({ ...current, suggestedAlternative: e.target.value }))
            }
          />
        </label>
        <div className="form-row">
          <button className="primary" type="button" onClick={createIntervention}>
            Create intervention
          </button>
          <button className="ghost" type="button" onClick={loadInterventions}>
            Refresh interventions
          </button>
        </div>
        <div className="queue" id="pharmacy-snapshots">
          {interventions.map((entry) => (
            <article key={entry.id} className="queue-card">
              <div className="queue-title">
                {entry.interventionType} | {entry.status} | {entry.severity || "moderate"}
              </div>
              <div className="queue-meta">
                Doctor: {entry.doctorId} | Patient: {entry.patientId} | Order: {entry.orderId || "n/a"}
              </div>
              <div className="queue-meta">{entry.details || "No details"}</div>
              {entry.status === "pending" ? (
                <div className="form-row">
                  <input
                    value={escalationReasonById[entry.id] || ""}
                    onChange={(e) =>
                      setEscalationReasonById((current) => ({ ...current, [entry.id]: e.target.value }))
                    }
                    placeholder="Escalation reason"
                  />
                  <button className="ghost" type="button" onClick={() => escalateIntervention(entry)}>
                    Escalate to doctor ack
                  </button>
                </div>
              ) : null}
            </article>
          ))}
          {!interventions.length ? <div className="meta">No interventions yet.</div> : null}
        </div>
      </div>
      ) : null}
      {activeSection === "compliance" ? (
      <div className="form">
        <div className="form-row">
          <h3>Compliance Events</h3>
          <label>
            Risk
            <select value={complianceRiskFilter} onChange={(e) => setComplianceRiskFilter(e.target.value)}>
              <option value="">All</option>
              <option value="critical">critical</option>
              <option value="high">high</option>
              <option value="moderate">moderate</option>
              <option value="low">low</option>
            </select>
          </label>
          <label>
            Reviewed
            <select value={complianceAckFilter} onChange={(e) => setComplianceAckFilter(e.target.value)}>
              <option value="all">all</option>
              <option value="unread">unread</option>
              <option value="read">read</option>
            </select>
          </label>
          <button className="ghost" type="button" onClick={loadComplianceEvents}>
            Refresh events
          </button>
          <button className="ghost" type="button" onClick={exportCurrentComplianceCsv}>
            Export CSV
          </button>
        </div>
        <div className="notice">
          Total: {complianceSummary.total} | Unread: {complianceSummary.unread} | Critical: {complianceSummary.critical} |
          High: {complianceSummary.high} | Moderate: {complianceSummary.moderate} | Low: {complianceSummary.low}
        </div>
        <div className="queue">
          {filteredComplianceEvents.map((event) => (
            <article
              key={event.id}
              className={`queue-card compliance-event-card compliance-event-card--${getComplianceRisk(event.eventType || event.type || event.riskLevel).level}`}
            >
              <div>
                <div className="queue-title">
                  {(event.eventType || event.type || "event").replaceAll("_", " ")} | {event.orderId}
                </div>
                <span
                  className={`compliance-risk-badge compliance-risk-badge--${getComplianceRisk(event.eventType || event.type || event.riskLevel).level}`}
                >
                  {getComplianceRisk(event.eventType || event.type || event.riskLevel).label}
                </span>
                <span
                  className={`compliance-review-badge ${event.acknowledged ? "compliance-review-badge--read" : "compliance-review-badge--unread"}`}
                >
                  {event.acknowledged ? "Reviewed" : "Unread"}
                </span>
              </div>
              <div className="queue-meta">
                {event.actorName || event.actorId || "System"} | {new Date(event.createdAt || event.at || Date.now()).toLocaleString()}
              </div>
              {event.details ? <div className="queue-meta">{event.details}</div> : null}
              <div className="queue-actions">
                <button
                  className="ghost"
                  type="button"
                  disabled={Boolean(event.acknowledged)}
                  onClick={() => markComplianceEventRead(event)}
                >
                  {event.acknowledged ? "Reviewed" : "Mark reviewed"}
                </button>
              </div>
            </article>
          ))}
          {!filteredComplianceEvents.length ? <div className="meta">No compliance events in this filter.</div> : null}
        </div>
        <div className="form-row">
          <input
            value={snapshotLabel}
            onChange={(e) => setSnapshotLabel(e.target.value)}
            placeholder="Snapshot label"
          />
          <button className="primary" type="button" onClick={createComplianceSnapshot}>
            Create immutable snapshot
          </button>
          <button className="ghost" type="button" onClick={loadComplianceSnapshots}>
            Refresh snapshots
          </button>
        </div>
        <div className="queue">
          {complianceSnapshots.map((snapshot) => (
            <article key={snapshot.id} className="queue-card compliance-snapshot-card">
              <div>
                <div className="queue-title">
                  {snapshot.label || "Compliance Snapshot"} | {snapshot.id}
                </div>
                <div className="queue-meta">
                  {new Date(snapshot.createdAt || Date.now()).toLocaleString()} | Immutable:{" "}
                  {snapshot.immutable ? "yes" : "no"}
                </div>
                <div className="queue-meta">
                  Checksum: {snapshot.checksum || "n/a"} | Events: {Number(snapshot?.summary?.total || 0)}
                </div>
                <div className="queue-meta">
                  Signature: {snapshot?.signature?.signatureHash || snapshot?.signatureHash || "not signed"}
                </div>
                <div className="queue-meta">
                  MOH status:{" "}
                  <span
                    className={`snapshot-integrity-badge ${
                      snapshot?.mohSubmission?.status === "approved"
                        ? "snapshot-integrity-badge--ok"
                        : snapshot?.mohSubmission?.status === "rejected"
                          ? "snapshot-integrity-badge--bad"
                          : snapshot?.mohSubmission?.status === "submitted"
                            ? "compliance-review-badge compliance-review-badge--unread"
                            : "compliance-review-badge compliance-review-badge--read"
                    }`}
                  >
                    {snapshot?.mohSubmission?.status || "not_submitted"}
                  </span>
                </div>
                {snapshotIntegrityById[snapshot.id] ? (
                  <div className="queue-meta">
                    <span
                      className={`snapshot-integrity-badge ${
                        snapshotIntegrityById[snapshot.id]?.overallValid
                          ? "snapshot-integrity-badge--ok"
                          : "snapshot-integrity-badge--bad"
                      }`}
                    >
                      {snapshotIntegrityById[snapshot.id]?.overallValid ? "Signature Chain Valid" : "Validation Failed"}
                    </span>{" "}
                    <span className="snapshot-subcheck">
                      I:{snapshotIntegrityById[snapshot.id]?.integrityOk ? "OK" : "FAIL"} | S:
                      {snapshotIntegrityById[snapshot.id]?.signatureOk ? "OK" : "FAIL"} | C:
                      {snapshotIntegrityById[snapshot.id]?.chainOk ? "OK" : "FAIL"}
                    </span>{" "}
                    {snapshotIntegrityById[snapshot.id]?.verifiedAt
                      ? `at ${new Date(snapshotIntegrityById[snapshot.id].verifiedAt).toLocaleString()}`
                      : ""}
                  </div>
                ) : null}
              </div>
              <div className="queue-actions">
                <button className="ghost" type="button" onClick={() => downloadSnapshotCsv(snapshot.id)}>
                  Download CSV
                </button>
                <button className="ghost" type="button" onClick={() => openSnapshotPrintView(snapshot.id)}>
                  Open print view
                </button>
                <button className="ghost" type="button" onClick={() => verifySnapshotIntegrity(snapshot.id)}>
                  Verify integrity
                </button>
                <input
                  value={snapshotSubmissionNoteById[snapshot.id] || ""}
                  onChange={(e) =>
                    setSnapshotSubmissionNoteById((current) => ({ ...current, [snapshot.id]: e.target.value }))
                  }
                  placeholder="Optional MOH submission note"
                />
                <label className="meta">
                  Attach proof screenshot/file
                  <input
                    type="file"
                    accept="image/*,.pdf"
                    multiple
                    onChange={(e) => addSnapshotEvidenceFiles(snapshot.id, e.target.files)}
                  />
                </label>
                {(snapshotEvidenceById[snapshot.id] || []).length ? (
                  <div className="queue-meta">
                    Attached: {(snapshotEvidenceById[snapshot.id] || []).map((entry) => entry.name).join(", ")}
                  </div>
                ) : null}
                <button
                  className="primary"
                  type="button"
                  onClick={() => submitSnapshotToMoh(snapshot.id)}
                  disabled={snapshot?.mohSubmission?.status === "submitted"}
                >
                  {snapshot?.mohSubmission?.status === "submitted" ? "Submitted" : "Submit to MOH"}
                </button>
              </div>
            </article>
          ))}
          {!complianceSnapshots.length ? <div className="meta">No snapshots yet.</div> : null}
        </div>
      </div>
      ) : null}
      {message ? <p className="notice">{message}</p> : null}
      {error ? <p className="notice error">{error}</p> : null}
      </div>
      </div>
    </section>
  );
}
