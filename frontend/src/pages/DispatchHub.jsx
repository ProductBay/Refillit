import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Circle, CircleMarker, MapContainer, Polyline, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { useAuth } from "../context/AuthContext.jsx";
import { apiFetch } from "../utils/api.js";

const AUTO_LOCATION_MIN_INTERVAL_MS = 15000;

const toCoord = (point) => {
  if (!point) return null;
  const lat = Number(point.lat ?? point.latitude);
  const lng = Number(point.lng ?? point.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lat, lng];
};

const getTrail = (order) =>
  (Array.isArray(order?.breadcrumbs) ? order.breadcrumbs : [])
    .map((crumb) => toCoord(crumb))
    .filter(Boolean);

function FitLiveMapBounds({ orders, selectedOrderId, centerOrderId, centerPoint, centerSignal }) {
  const map = useMap();

  useEffect(() => {
    const focus = selectedOrderId ? orders.filter((entry) => entry.id === selectedOrderId) : orders;
    const source = focus.length ? focus : orders;
    const points = [];
    for (const order of source) {
      const destination = toCoord(order.destination);
      const courier = toCoord(order.courierPosition || order.dispatchLastLocation);
      const trail = getTrail(order);
      if (destination) points.push(destination);
      if (courier) points.push(courier);
      for (const t of trail) points.push(t);
    }
    if (!points.length) return;
    if (points.length === 1) {
      map.setView(points[0], 14, { animate: true });
      return;
    }
    map.fitBounds(points, { padding: [30, 30] });
  }, [map, orders, selectedOrderId]);

  useEffect(() => {
    if (!centerSignal) return;
    if (centerPoint && Number.isFinite(Number(centerPoint.lat)) && Number.isFinite(Number(centerPoint.lng))) {
      map.setView([Number(centerPoint.lat), Number(centerPoint.lng)], 16, { animate: true });
      return;
    }
    if (!centerOrderId) return;
    const target = orders.find((entry) => entry.id === centerOrderId) || null;
    const courier = toCoord(target?.courierPosition || target?.dispatchLastLocation);
    const pharmacyLoc = toCoord(target?.pharmacyLocation);
    const destination = toCoord(target?.destination);
    // Prefer courier location, but fall back to pharmacy location or destination
    if (courier) {
      map.setView(courier, 16, { animate: true });
      return;
    }
    if (pharmacyLoc) {
      map.setView(pharmacyLoc, 16, { animate: true });
      return;
    }
    if (destination) {
      map.setView(destination, 16, { animate: true });
      return;
    }
  }, [map, orders, centerOrderId, centerPoint, centerSignal]);

  return null;
}

export default function DispatchHub({ mode = "auto" }) {
  const { apiBase, token, user } = useAuth();
  const role = String(user?.role || "").toLowerCase();
  const isCourierRole = role === "courier";
  const isOpsRole = role === "pharmacy" || role === "admin";
  const showCourierUI = mode === "courier" || (mode === "auto" && isCourierRole);
  const showOpsUI = mode === "dispatch" || (mode === "auto" && isOpsRole);
  const useCourierLikeLayout = showCourierUI || showOpsUI;
  const canCourierActions = isCourierRole;
  const canOpsActions = isOpsRole;
  const [orders, setOrders] = useState([]);
  const [myJobs, setMyJobs] = useState([]);
  const [exceptions, setExceptions] = useState([]);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [queueStatus, setQueueStatus] = useState("");
  const [courierId, setCourierId] = useState("");
  const [etaStart, setEtaStart] = useState("");
  const [etaEnd, setEtaEnd] = useState("");
  const [otpValue, setOtpValue] = useState("");
  const [otpMeta, setOtpMeta] = useState(null);
  const [issuedOtpPreview, setIssuedOtpPreview] = useState("");
  const [podMethod, setPodMethod] = useState("otp");
  const [podProof, setPodProof] = useState("123456");
  const [identityChecklist, setIdentityChecklist] = useState({
    confirmRecipientName: false,
    confirmAddress: false,
    confirmOrderId: false,
    note: "",
  });
  const [podAccuracyMeters, setPodAccuracyMeters] = useState("15");
  const [capturedPhotoData, setCapturedPhotoData] = useState("");
  const [capturedPhotoName, setCapturedPhotoName] = useState("");
  const [capturedSignatureData, setCapturedSignatureData] = useState("");
  const [otpQrToken, setOtpQrToken] = useState("");
  const [qrScanActive, setQrScanActive] = useState(false);
  const [qrScanError, setQrScanError] = useState("");
  const [autoApproveOnQrScan, setAutoApproveOnQrScan] = useState(true);
  const [failReason, setFailReason] = useState("no_answer");
  const [unsafeReason, setUnsafeReason] = useState("");
  const [commSession, setCommSession] = useState(null);
  const [messageTemplates, setMessageTemplates] = useState([]);
  const [messageTemplateKey, setMessageTemplateKey] = useState("arriving_10");
  const [messageEtaMinutes, setMessageEtaMinutes] = useState("10");
  const [customSecureMessage, setCustomSecureMessage] = useState("");
  const [jobChecklist, setJobChecklist] = useState({
    readInstructions: false,
    confirmedAddress: false,
    confirmedRecipient: false,
    askedGateCode: false,
    note: "",
  });
  const [scorecard, setScorecard] = useState(null);
  const [coachingPrompts, setCoachingPrompts] = useState([]);
  const [overrideAction, setOverrideAction] = useState("unlock_otp");
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideCourierId, setOverrideCourierId] = useState("");
  const [timeline, setTimeline] = useState([]);
  const [eventFeed, setEventFeed] = useState([]);
  const [liveMap, setLiveMap] = useState({ generatedAt: null, geofenceRadiusMeters: 0, orders: [] });
  const [nextStops, setNextStops] = useState({ generatedAt: null, courierLocation: null, stops: [] });
  const [courierWorkload, setCourierWorkload] = useState({
    generatedAt: null,
    summary: { couriers: 0, activeJobs: 0, overdueJobs: 0 },
    couriers: [],
  });
  const [slaCockpit, setSlaCockpit] = useState({
    generatedAt: null,
    summary: { active: 0, breached: 0, atRisk: 0 },
    breaches: [],
    atRisk: [],
  });
  const [autoDispatchReason, setAutoDispatchReason] = useState(
    "Auto-balance queue for SLA and courier load coverage."
  );
  const [escalationReason, setEscalationReason] = useState("");
  const [locationLat, setLocationLat] = useState("");
  const [locationLng, setLocationLng] = useState("");
  const [selectedBatchOrderIds, setSelectedBatchOrderIds] = useState([]);
  const [batchAction, setBatchAction] = useState("assign");
  const [batchReason, setBatchReason] = useState("");
  const [batchCourierId, setBatchCourierId] = useState("");
  const [batchPriority, setBatchPriority] = useState("high");
  const [courierAvailability, setCourierAvailability] = useState({
    online: true,
    updatedAt: null,
    updatedBy: null,
  });
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(20);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isOnline, setIsOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [offlineQueue, setOfflineQueue] = useState([]);
  const [isFlushingQueue, setIsFlushingQueue] = useState(false);
  const [showOfflineInspector, setShowOfflineInspector] = useState(false);
  const [retryingOfflineId, setRetryingOfflineId] = useState("");
  const [clockMs, setClockMs] = useState(Date.now());
  const [showDeviationOnly, setShowDeviationOnly] = useState(false);
  const [breachAlert, setBreachAlert] = useState("");
  const [autoLocationEnabled, setAutoLocationEnabled] = useState(false);
  const [autoLocationLastAt, setAutoLocationLastAt] = useState(null);
  const [autoLocationError, setAutoLocationError] = useState("");
  const [courierAckAccepted, setCourierAckAccepted] = useState(false);
  const courierAckKey = `courier_ack_${String(user?.id || "anon")}`;
  const [mapCenterSignal, setMapCenterSignal] = useState(0);
  const [mapCenterOrderId, setMapCenterOrderId] = useState("");
  const [mapCenterPoint, setMapCenterPoint] = useState(null);
  const [mapCenterCourierId, setMapCenterCourierId] = useState("");
  const [pulseTick, setPulseTick] = useState(0);
  const [lastReroute, setLastReroute] = useState(null);
  const [compactCourierMode, setCompactCourierMode] = useState(false);
  const [consolePanelOpen, setConsolePanelOpen] = useState({
    controls: true,
    eta: true,
    pod: true,
    exceptions: true,
    communication: true,
    checklist: true,
  });
  const prevBreachedCountRef = useRef(0);
  const geoWatchIdRef = useRef(null);
  const autoLocationLastSentMsRef = useRef(0);
  const courierPresencePingMsRef = useRef(0);
  const signatureCanvasRef = useRef(null);
  const signatureDrawingRef = useRef(false);
  const signatureHasStrokeRef = useRef(false);
  const qrVideoRef = useRef(null);
  const qrStreamRef = useRef(null);
  const qrDetectorRef = useRef(null);
  const qrScanRafRef = useRef(null);
  const offlineQueueKey = `dispatch_offline_queue_${String(user?.id || "anon")}`;
  const courierLayoutPrefsKey = `dispatch_courier_layout_${String(user?.id || "anon")}`;
  const emergencyPhone = String(import.meta.env.VITE_EMERGENCY_PHONE || "911").trim();
  const dispatchHotline = String(import.meta.env.VITE_DISPATCH_HOTLINE || "+18765550100").trim();
  const courierIdentity = useMemo(
    () => ({
      fullName: String(user?.fullName || "").trim() || "Courier User",
      userId: String(user?.id || "").trim() || "n/a",
      platformStaffId: String(user?.platformStaffId || "").trim() || "n/a",
      email: String(user?.email || "").trim() || "n/a",
    }),
    [user]
  );

  // load courier acknowledgment state from localStorage so courier must accept on login
  useEffect(() => {
    try {
      if (!user || String(user?.role || "").toLowerCase() !== "courier") return;
      const key = `courier_ack_${String(user?.id || "anon")}`;
      const raw = localStorage.getItem(key);
      if (raw === "true") setCourierAckAccepted(true);
    } catch (_err) {
      // ignore
    }
  }, [user]);

  const acceptCourierAcknowledgement = () => {
    try {
      const key = `courier_ack_${String(user?.id || "anon")}`;
      localStorage.setItem(key, "true");
    } catch (_err) {
      // ignore
    }
    setCourierAckAccepted(true);
  };

  const selectedOrderId = selectedOrder?.id || "";
  const identityChecklistComplete =
    identityChecklist.confirmRecipientName
    && identityChecklist.confirmAddress
    && identityChecklist.confirmOrderId;
  const liveMapOrders = useMemo(() => {
    const rows = (Array.isArray(liveMap.orders) ? liveMap.orders : []).filter(
      (entry) => toCoord(entry.destination) || toCoord(entry.courierPosition || entry.dispatchLastLocation)
    );
    if (!showDeviationOnly) return rows;
    return rows.filter((entry) => Boolean(entry.routeDeviation));
  }, [liveMap.orders, showDeviationOnly]);

  const mapListOrders = useMemo(() => {
    const rows = Array.isArray(liveMap.orders) ? liveMap.orders : [];
    if (!showDeviationOnly) return rows;
    return rows.filter((entry) => Boolean(entry.routeDeviation));
  }, [liveMap.orders, showDeviationOnly]);
  const opsCourierRoster = useMemo(() => {
    const rows = Array.isArray(courierWorkload?.couriers) ? courierWorkload.couriers : [];
    const mapOrders = Array.isArray(liveMap?.orders) ? liveMap.orders : [];
    const latestByCourier = new Map();
    for (const order of mapOrders) {
      const cid = String(order?.courierId || "").trim();
      if (!cid) continue;
      const point = order?.courierPosition || order?.dispatchLastLocation || null;
      if (!point) continue;
      const lat = Number(point?.lat ?? point?.latitude);
      const lng = Number(point?.lng ?? point?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const atIso = String(point?.at || order?.updatedAt || "").trim();
      const atMs = new Date(atIso || 0).getTime() || 0;
      const prev = latestByCourier.get(cid);
      if (!prev || atMs >= prev.atMs) {
        latestByCourier.set(cid, {
          orderId: String(order?.id || ""),
          lat,
          lng,
          atIso: atIso || null,
          atMs,
        });
      }
    }
    return rows
      .map((entry) => {
        const cid = String(entry?.courierId || "").trim();
        const activeJobs = Number(entry?.activeJobs || 0);
        const band = String(entry?.loadBand || "").toLowerCase();
        const location = latestByCourier.get(cid) || null;
        const online = entry?.online !== false;
        const availability = !online
          ? "offline"
          : band === "critical" || activeJobs >= 5
            ? "busy"
            : activeJobs >= 3
              ? "limited"
              : "available";
        return {
          courierId: cid,
          courierName: String(entry?.courierName || "").trim() || cid || "Courier",
          zone: entry?.zone || null,
          loadBand: band || "idle",
          online,
          activeJobs,
          overdueJobs: Number(entry?.overdueJobs || 0),
          assignedTotal: Number(entry?.assignedTotal || 0),
          availability,
          location,
        };
      })
      .sort((a, b) => {
        const weight = { available: 0, limited: 1, busy: 2, offline: 3 };
        const aw = Number(weight[a.availability] ?? 3);
        const bw = Number(weight[b.availability] ?? 3);
        if (aw !== bw) return aw - bw;
        if (a.activeJobs !== b.activeJobs) return a.activeJobs - b.activeJobs;
        return String(a.courierName || "").localeCompare(String(b.courierName || ""));
      });
  }, [courierWorkload.couriers, liveMap.orders]);
  const selectedOpsCourierEntry = useMemo(
    () => opsCourierRoster.find((entry) => String(entry.courierId || "") === String(courierId || "")) || null,
    [opsCourierRoster, courierId]
  );
  const courierOnlineById = useMemo(() => {
    const index = new Map();
    for (const entry of opsCourierRoster) {
      const key = String(entry?.courierId || "").trim();
      if (!key) continue;
      index.set(key, entry?.online !== false);
    }
    return index;
  }, [opsCourierRoster]);

  const filteredQueue = useMemo(() => {
    if (!queueStatus) return orders;
    return orders.filter((entry) => String(entry.dispatchStatus || "").toLowerCase() === queueStatus);
  }, [orders, queueStatus]);
  const dispatchSummary = useMemo(() => {
    const summary = {
      total: filteredQueue.length,
      queued: 0,
      active: 0,
      delivered: 0,
      failed: 0,
    };
    for (const entry of filteredQueue) {
      const status = String(entry.dispatchStatus || "").toLowerCase();
      if (status === "queued") summary.queued += 1;
      if (["assigned", "accepted", "picked_up", "arrived"].includes(status)) summary.active += 1;
      if (status === "delivered") summary.delivered += 1;
      if (status === "failed") summary.failed += 1;
    }
    return summary;
  }, [filteredQueue]);
  const myJobsRiskSummary = useMemo(() => {
    const jobs = Array.isArray(myJobs) ? myJobs : [];
    const atRisk = jobs.filter((entry) => Boolean(entry?.sla?.atRisk));
    const breached = jobs.filter(
      (entry) => Boolean(entry?.sla?.breached) || Number(entry?.sla?.etaOverdueMinutes || 0) > 0
    );
    return {
      atRisk: atRisk.length,
      breached: breached.length,
    };
  }, [myJobs]);
  const pinnedActiveOrder = useMemo(() => {
    if (selectedOrder) return selectedOrder;
    if (showCourierUI && Array.isArray(myJobs) && myJobs.length) return myJobs[0];
    return null;
  }, [selectedOrder, showCourierUI, myJobs]);

  const loadQueue = async () => {
    try {
      const qs = queueStatus ? `?status=${encodeURIComponent(queueStatus)}` : "";
      const data = await apiFetch({ apiBase, token, path: `/api/dispatch/queue${qs}` });
      setOrders(data.orders || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadMyJobs = async () => {
    if (!showCourierUI) return;
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/dispatch/my-jobs" });
      setMyJobs(data.orders || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadExceptions = async () => {
    if (!showOpsUI) return;
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/dispatch/exceptions" });
      setExceptions(data.exceptions || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadNextStops = async () => {
    if (!showCourierUI) return;
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/dispatch/next-stops?limit=8" });
      setNextStops({
        generatedAt: data.generatedAt || null,
        courierLocation: data.courierLocation || null,
        stops: Array.isArray(data.stops) ? data.stops : [],
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const loadLiveMap = async () => {
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/dispatch/live-map" });
      const nextState = {
        generatedAt: data.generatedAt || null,
        geofenceRadiusMeters: Number(data.geofenceRadiusMeters || 0),
        orders: Array.isArray(data.orders) ? data.orders : [],
      };
      setLiveMap(nextState);
      return nextState;
    } catch (err) {
      setError(err.message);
      return null;
    }
  };

  const loadSlaCockpit = async () => {
    if (!showOpsUI) return;
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/dispatch/sla-cockpit" });
      setSlaCockpit({
        generatedAt: data.generatedAt || null,
        summary: data.summary || { active: 0, breached: 0, atRisk: 0 },
        breaches: Array.isArray(data.breaches) ? data.breaches : [],
        atRisk: Array.isArray(data.atRisk) ? data.atRisk : [],
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const loadCourierWorkload = async () => {
    if (!showOpsUI) return;
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/dispatch/courier-workload" });
      const nextState = {
        generatedAt: data.generatedAt || null,
        summary: data.summary || { couriers: 0, activeJobs: 0, overdueJobs: 0 },
        couriers: Array.isArray(data.couriers) ? data.couriers : [],
      };
      setCourierWorkload(nextState);
      return nextState;
    } catch (err) {
      setError(err.message);
      return null;
    }
  };

  const loadTimeline = async (orderId) => {
    if (!orderId) {
      setTimeline([]);
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/dispatch/${orderId}/timeline`,
      });
      setTimeline(data.timeline || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadEventFeed = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/dispatch/events?limit=100",
      });
      setEventFeed(Array.isArray(data?.events) ? data.events : []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadMessageTemplates = async () => {
    if (!showCourierUI) return;
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/dispatch/message-templates" });
      const templates = Array.isArray(data.templates) ? data.templates : [];
      setMessageTemplates(templates);
      if (templates.length && !templates.some((entry) => entry.key === messageTemplateKey)) {
        setMessageTemplateKey(String(templates[0].key || "arriving_10"));
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const loadScorecard = async () => {
    if (!showCourierUI) return;
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/dispatch/scorecard/my" });
      setScorecard(data.scorecard || null);
      setCoachingPrompts(Array.isArray(data.prompts) ? data.prompts : []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadCourierAvailability = async () => {
    if (!showCourierUI) return;
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/dispatch/courier-availability/me" });
      setCourierAvailability({
        online: data?.online !== false,
        updatedAt: data?.updatedAt || null,
        updatedBy: data?.updatedBy || null,
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const shouldQueueOffline = (err) => {
    if (!isOnline) return true;
    const messageText = String(err?.message || "").toLowerCase();
    return messageText.includes("failed to fetch") || messageText.includes("network");
  };

  const enqueueOfflineMutation = ({ path, body, label }) => {
    const item = {
      id: `off-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      path,
      body: body || {},
      label: String(label || path || "mutation"),
      createdAt: new Date().toISOString(),
      retries: 0,
      lastError: "",
      lastTriedAt: null,
    };
    setOfflineQueue((prev) => [...prev, item].slice(-80));
    return item;
  };

  const removeOfflineItem = (itemId) => {
    const id = String(itemId || "").trim();
    if (!id) return;
    setOfflineQueue((prev) => prev.filter((entry) => String(entry.id || "") !== id));
  };

  const retryOfflineItem = async (item) => {
    if (!item?.id) return;
    if (!isOnline) {
      setError("Cannot retry while offline.");
      return;
    }
    setRetryingOfflineId(String(item.id));
    try {
      await apiFetch({
        apiBase,
        token,
        path: item.path,
        method: "POST",
        body: item.body || {},
      });
      setOfflineQueue((prev) => prev.filter((entry) => String(entry.id || "") !== String(item.id || "")));
      setMessage(`Retried and synced: ${item.label || item.path}`);
      setError("");
      await refresh();
    } catch (err) {
      setOfflineQueue((prev) =>
        prev.map((entry) =>
          String(entry.id || "") === String(item.id || "")
            ? {
                ...entry,
                retries: Number(entry.retries || 0) + 1,
                lastError: String(err?.message || "retry failed"),
                lastTriedAt: new Date().toISOString(),
              }
            : entry
        )
      );
      setError(err?.message || "Retry failed");
    } finally {
      setRetryingOfflineId("");
    }
  };

  const flushOfflineQueue = async () => {
    if (!offlineQueue.length || !isOnline || isFlushingQueue) return;
    setIsFlushingQueue(true);
    try {
      const pending = [...offlineQueue];
      const failed = [];
      for (const item of pending) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await apiFetch({
            apiBase,
            token,
            path: item.path,
            method: "POST",
            body: item.body || {},
          });
        } catch (_err) {
          failed.push({
            ...item,
            retries: Number(item.retries || 0) + 1,
            lastError: String(_err?.message || "sync failed"),
            lastTriedAt: new Date().toISOString(),
          });
        }
      }
      setOfflineQueue(failed);
      if (failed.length) {
        setMessage(`Synced ${pending.length - failed.length} queued actions, ${failed.length} still pending.`);
      } else {
        setMessage(`Synced ${pending.length} queued action${pending.length === 1 ? "" : "s"}.`);
      }
      await refresh();
    } finally {
      setIsFlushingQueue(false);
    }
  };

  const refresh = async () => {
    setIsRefreshing(true);
    try {
      if (showOpsUI) await loadQueue();
      else setOrders([]);
      if (showCourierUI) await loadMyJobs();
      else setMyJobs([]);
      if (showCourierUI) await loadNextStops();
      else setNextStops({ generatedAt: null, courierLocation: null, stops: [] });
      if (showCourierUI) await loadMessageTemplates();
      else setMessageTemplates([]);
      if (showCourierUI) await loadScorecard();
      else {
        setScorecard(null);
        setCoachingPrompts([]);
      }
      if (showCourierUI) await loadCourierAvailability();
      else setCourierAvailability({ online: true, updatedAt: null, updatedBy: null });
      if (showOpsUI) await loadExceptions();
      else setExceptions([]);
      await loadLiveMap();
      await loadEventFeed();
      if (showOpsUI) await loadCourierWorkload();
      else {
        setCourierWorkload({
          generatedAt: null,
          summary: { couriers: 0, activeJobs: 0, overdueJobs: 0 },
          couriers: [],
        });
      }
      if (showOpsUI) await loadSlaCockpit();
      else {
        setSlaCockpit({
          generatedAt: null,
          summary: { active: 0, breached: 0, atRisk: 0 },
          breaches: [],
          atRisk: [],
        });
      }
      if (selectedOrderId) await loadTimeline(selectedOrderId);
      setLastSyncAt(new Date().toISOString());
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    refresh().catch((err) => setError(err?.message || "Failed to refresh dispatch data"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueStatus, showOpsUI, showCourierUI]);

  useEffect(() => {
    if (!autoRefreshEnabled) return undefined;
    const ms = Math.max(5000, Number(autoRefreshSeconds || 20) * 1000);
    const timer = setInterval(() => {
      refresh().catch((err) => setError(err?.message || "Failed to refresh dispatch data"));
    }, ms);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefreshEnabled, autoRefreshSeconds, selectedOrderId, showOpsUI, showCourierUI]);

  useEffect(() => {
    if (!showCourierUI || !canCourierActions) return;
    if (courierAvailability.online === false) return;
    if (!isOnline) return;
    const now = Date.now();
    if (now - Number(courierPresencePingMsRef.current || 0) < 60_000) return;
    courierPresencePingMsRef.current = now;
    pingDispatchLocation({ silent: true, refreshAfter: false, source: "presence_auto_login" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCourierUI, canCourierActions, courierAvailability.online, isOnline]);

  useEffect(() => {
    if (!showOpsUI) return undefined;
    const timer = setInterval(() => {
      Promise.all([loadCourierWorkload(), loadLiveMap()]).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showOpsUI, apiBase, token]);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(offlineQueueKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) setOfflineQueue(parsed);
    } catch (_err) {
      // Ignore malformed cache.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offlineQueueKey]);

  useEffect(() => {
    try {
      localStorage.setItem(offlineQueueKey, JSON.stringify(offlineQueue));
    } catch (_err) {
      // Ignore storage failures.
    }
  }, [offlineQueue, offlineQueueKey]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(courierLayoutPrefsKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.compactCourierMode === "boolean") {
        setCompactCourierMode(parsed.compactCourierMode);
      }
      if (parsed?.consolePanelOpen && typeof parsed.consolePanelOpen === "object") {
        setConsolePanelOpen((prev) => ({ ...prev, ...parsed.consolePanelOpen }));
      }
    } catch (_err) {
      // Ignore malformed layout prefs.
    }
  }, [courierLayoutPrefsKey]);

  useEffect(() => {
    try {
      localStorage.setItem(
        courierLayoutPrefsKey,
        JSON.stringify({
          compactCourierMode,
          consolePanelOpen,
        })
      );
    } catch (_err) {
      // Ignore storage failures.
    }
  }, [compactCourierMode, consolePanelOpen, courierLayoutPrefsKey]);

  const updateConsolePanelOpen = (panel, isOpen) => {
    if (!panel) return;
    setConsolePanelOpen((prev) => ({ ...prev, [panel]: Boolean(isOpen) }));
  };

  const toggleConsolePanel = (panel) => {
    if (!panel) return;
    setConsolePanelOpen((prev) => ({ ...prev, [panel]: !Boolean(prev[panel]) }));
  };

  const selectCourierJob = (entry) => {
    if (!entry) return;
    setSelectedOrder(entry);
    setCourierId(entry.courierId || "");
    setOverrideCourierId(entry.courierId || "");
    loadTimeline(entry.id);
  };

  const jumpToNextAssignedJob = () => {
    const jobs = Array.isArray(myJobs) ? myJobs : [];
    if (!jobs.length) return;
    const currentIndex = jobs.findIndex((entry) => String(entry.id || "") === String(selectedOrderId || ""));
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % jobs.length : 0;
    const nextJob = jobs[nextIndex];
    selectCourierJob(nextJob);
    setMessage(`Jumped to job ${nextJob?.id || "n/a"}.`);
    setError("");
  };

  useEffect(() => {
    if (!showCourierUI) return undefined;
    const isTypingTarget = (target) => {
      if (!target) return false;
      const tag = String(target.tagName || "").toLowerCase();
      if (["input", "textarea", "select", "button"].includes(tag)) return true;
      return Boolean(target.isContentEditable);
    };
    const panelKeys = ["controls", "eta", "pod", "exceptions", "communication", "checklist"];
    const onKeyDown = (event) => {
      if (!showCourierUI) return;
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const key = String(event.key || "").toLowerCase();
      if (key === "c") {
        event.preventDefault();
        setCompactCourierMode((prev) => !prev);
        return;
      }
      if (key === "n") {
        event.preventDefault();
        jumpToNextAssignedJob();
        return;
      }
      const num = Number(key);
      if (Number.isInteger(num) && num >= 1 && num <= 6) {
        event.preventDefault();
        toggleConsolePanel(panelKeys[num - 1]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCourierUI, myJobs, selectedOrderId]);

  useEffect(() => {
    if (!showCourierUI) return;
    const fallbackCourierId = String(user?.id || "").trim();
    if (!fallbackCourierId) return;
    setCourierId((current) => (String(current || "").trim() ? current : fallbackCourierId));
    setOverrideCourierId((current) => (String(current || "").trim() ? current : fallbackCourierId));
  }, [showCourierUI, user?.id]);

  useEffect(() => {
    if (!isOnline) return;
    flushOfflineQueue().catch((err) => setError(err?.message || "Failed to sync offline queue"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  useEffect(() => {
    const timer = setInterval(() => setClockMs(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const pulseTimer = setInterval(() => setPulseTick((prev) => (prev + 1) % 1000), 700);
    return () => clearInterval(pulseTimer);
  }, []);

  useEffect(() => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const width = canvas.clientWidth || 320;
    const height = canvas.clientHeight || 120;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = "#1f2937";
  }, [selectedOrderId, podMethod]);

  useEffect(() => () => {
    if (qrScanRafRef.current) cancelAnimationFrame(qrScanRafRef.current);
    qrScanRafRef.current = null;
    if (qrStreamRef.current) {
      qrStreamRef.current.getTracks().forEach((track) => track.stop());
      qrStreamRef.current = null;
    }
    qrDetectorRef.current = null;
  }, []);

  useEffect(() => {
    if (!autoLocationEnabled || !selectedOrderId) return undefined;
    if (!navigator.geolocation) {
      setAutoLocationError("Geolocation is not supported by this browser.");
      setAutoLocationEnabled(false);
      return undefined;
    }

    setAutoLocationError("");

    if (canCourierActions) {
      // Courier: watch device geolocation and submit to server
      geoWatchIdRef.current = navigator.geolocation.watchPosition(
        (position) => {
          const lat = Number(position.coords?.latitude);
          const lng = Number(position.coords?.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
          setLocationLat(lat.toFixed(6));
          setLocationLng(lng.toFixed(6));
          const nowMs = Date.now();
          if (nowMs - Number(autoLocationLastSentMsRef.current || 0) < AUTO_LOCATION_MIN_INTERVAL_MS) return;
          autoLocationLastSentMsRef.current = nowMs;
          submitCourierLocation({
            orderId: selectedOrderId,
            lat,
            lng,
            refreshAfter: false,
            silent: true,
            source: "auto",
          });
        },
        (geoErr) => {
          setAutoLocationError(geoErr?.message || "Unable to read current location.");
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 5000,
        }
      );
    } else if (canOpsActions) {
      // Ops/dispatch: poll server for courier location updates for selected order
      setAutoLocationError("");
      const poll = async () => {
        try {
          await loadLiveMap();
          setAutoLocationLastAt(new Date().toISOString());
        } catch (err) {
          setAutoLocationError(String(err?.message || "Failed to fetch live map"));
        }
      };
      // initial fetch
      poll();
      const intervalId = setInterval(poll, AUTO_LOCATION_MIN_INTERVAL_MS);
      geoWatchIdRef.current = intervalId;
    }

    return () => {
      if (geoWatchIdRef.current !== null) {
        try {
          if (canCourierActions && navigator.geolocation?.clearWatch) {
            navigator.geolocation.clearWatch(geoWatchIdRef.current);
          } else {
            clearInterval(geoWatchIdRef.current);
          }
        } catch (e) {
          // ignore
        }
        geoWatchIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLocationEnabled, canCourierActions, canOpsActions, selectedOrderId, apiBase, token]);

  useEffect(() => {
    if (selectedOrderId) return;
    setAutoLocationEnabled(false);
  }, [selectedOrderId]);

  useEffect(() => {
    setIdentityChecklist({
      confirmRecipientName: false,
      confirmAddress: false,
      confirmOrderId: false,
      note: "",
    });
  }, [selectedOrderId]);

  useEffect(() => {
    const checklist = selectedOrder?.dispatchChecklist || {};
    setJobChecklist({
      readInstructions: checklist.readInstructions === true,
      confirmedAddress: checklist.confirmedAddress === true,
      confirmedRecipient: checklist.confirmedRecipient === true,
      askedGateCode: checklist.askedGateCode === true,
      note: String(checklist.note || ""),
    });
    const sessions = Array.isArray(selectedOrder?.dispatchCommSessions) ? selectedOrder.dispatchCommSessions : [];
    setCommSession(sessions.length ? sessions[sessions.length - 1] : null);
  }, [selectedOrder]);

  useEffect(() => {
    if (podMethod.includes("qr")) return;
    stopQrScanner();
    setOtpQrToken("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [podMethod]);

  useEffect(() => {
    const nextCount = Number(slaCockpit.summary?.breached || 0);
    const prevCount = Number(prevBreachedCountRef.current || 0);
    prevBreachedCountRef.current = nextCount;
    if (nextCount > prevCount) {
      const delta = nextCount - prevCount;
      const msg = `SLA alert: ${delta} new breached order${delta > 1 ? "s" : ""} detected.`;
      setBreachAlert(msg);
      try {
        const ctx = new window.AudioContext();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "triangle";
        oscillator.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.27);
      } catch (_err) {
        // Browser may block autoplay audio until user interaction.
      }
      const hideTimer = setTimeout(() => setBreachAlert(""), 9000);
      return () => clearTimeout(hideTimer);
    }
    return undefined;
  }, [slaCockpit.summary?.breached]);

  const assign = async () => {
    if (!selectedOrderId || !courierId.trim()) {
      setError("Select an order and provide courier user ID.");
      return;
    }
    if (showOpsUI && selectedOpsCourierEntry && selectedOpsCourierEntry.online === false) {
      setError("Selected courier is offline. Choose an online courier.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/dispatch/assign",
        method: "POST",
        body: { orderId: selectedOrderId, courierId: courierId.trim() },
      });
      setMessage(`Assigned. Dispatch: ${data.order.dispatchStatus || "assigned"}`);
      setError("");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const runCourierAction = async (actionPath, body = {}, { allowOfflineQueue = true, label = "" } = {}) => {
    if (!selectedOrderId) {
      setError("Select an order first.");
      return;
    }
    const path = `/api/dispatch/${selectedOrderId}/${actionPath}`;
    if (!isOnline && allowOfflineQueue) {
      const queued = enqueueOfflineMutation({
        path,
        body,
        label: label || actionPath,
      });
      setMessage(`Offline: queued ${queued.label} action.`);
      setError("");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path,
        method: "POST",
        body,
      });
      setSelectedOrder(data.order || null);
      if (data.otpMeta) setOtpMeta(data.otpMeta);
      const geofenceSuffix =
        data?.geofence?.checked && data?.geofence?.withinRadius === false
          ? ` | Geofence warning (${data.geofence.distanceMeters}m > ${data.geofence.radiusMeters}m)`
          : "";
      setMessage(`Updated. Dispatch: ${data.order?.dispatchStatus || "ok"}${geofenceSuffix}`);
      setError("");
      await refresh();
    } catch (err) {
      if (allowOfflineQueue && shouldQueueOffline(err)) {
        const queued = enqueueOfflineMutation({
          path,
          body,
          label: label || actionPath,
        });
        setMessage(`Offline detected: queued ${queued.label} action.`);
        setError("");
        return;
      }
      setError(err.message);
    }
  };

  const formatEta = (value) => {
    if (!value) return "n/a";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "n/a";
    return date.toLocaleString();
  };

  const getLocationTimestamp = (entry) => {
    if (!entry) return null;
    return (
      entry?.dispatchLastLocation?.at
      || entry?.courierPosition?.at
      || entry?.location?.at
      || null
    );
  };

  const formatLocationAge = (entry) => {
    const raw = getLocationTimestamp(entry);
    if (!raw) return "n/a";
    const atMs = new Date(raw).getTime();
    if (Number.isNaN(atMs)) return "n/a";
    const diffSec = Math.max(0, Math.floor((clockMs - atMs) / 1000));
    if (diffSec < 15) return "just now";
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    return `${diffHours}h ago`;
  };

  const toIsoOrNull = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  };

  const liveMinutesToBreach = (entry) => {
    const base = Number(entry?.sla?.minutesToBreach);
    if (!Number.isFinite(base)) return null;
    const generatedAtMs = Number(new Date(slaCockpit.generatedAt || Date.now()).getTime());
    const elapsedMinutes = Math.max(0, Math.floor((clockMs - generatedAtMs) / 60000));
    return base - elapsedMinutes;
  };

  const formatSlaCountdown = (entry) => {
    const remaining = liveMinutesToBreach(entry);
    if (remaining === null) return "n/a";
    if (remaining >= 0) return `${remaining}m to breach`;
    return `Breached ${Math.abs(remaining)}m ago`;
  };

  const formatOtpDeliveryStatus = (entry) => {
    const summary = entry?.otpDeliverySummary || entry?.dispatchOtpLastDelivery || null;
    if (!summary) return "not_sent";
    const deliveredVia = String(summary.deliveredVia || "").trim();
    if (summary.success && deliveredVia) return `delivered_via_${deliveredVia}`;
    const channels = Array.isArray(summary.channels) ? summary.channels : [];
    const latest = channels[channels.length - 1];
    if (latest?.channel && latest?.status) return `${latest.channel}:${latest.status}`;
    return summary.success ? "sent" : "failed";
  };

  const clearSignatureCapture = () => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.clientWidth || 320;
    const height = canvas.clientHeight || 120;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    signatureHasStrokeRef.current = false;
    setCapturedSignatureData("");
  };

  const pointerToCanvasPoint = (event) => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const startSignatureStroke = (event) => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const point = pointerToCanvasPoint(event);
    if (!ctx || !point) return;
    signatureDrawingRef.current = true;
    signatureHasStrokeRef.current = true;
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
  };

  const continueSignatureStroke = (event) => {
    if (!signatureDrawingRef.current) return;
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const point = pointerToCanvasPoint(event);
    if (!ctx || !point) return;
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
  };

  const endSignatureStroke = () => {
    if (!signatureDrawingRef.current) return;
    signatureDrawingRef.current = false;
    if (!signatureHasStrokeRef.current) return;
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    setCapturedSignatureData(canvas.toDataURL("image/png"));
  };

  const handlePhotoCaptureFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      setCapturedPhotoData("");
      setCapturedPhotoName("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      if (!dataUrl.startsWith("data:")) {
        setError("Invalid photo capture. Please try again.");
        return;
      }
      setCapturedPhotoData(dataUrl);
      setCapturedPhotoName(file.name || "captured-photo");
      setError("");
    };
    reader.onerror = () => setError("Unable to read captured photo.");
    reader.readAsDataURL(file);
  };

  const stopQrScanner = () => {
    if (qrScanRafRef.current) cancelAnimationFrame(qrScanRafRef.current);
    qrScanRafRef.current = null;
    if (qrStreamRef.current) {
      qrStreamRef.current.getTracks().forEach((track) => track.stop());
      qrStreamRef.current = null;
    }
    if (qrVideoRef.current) qrVideoRef.current.srcObject = null;
    setQrScanActive(false);
  };

  const scanQrLoop = (autoApprove = true) => {
    const video = qrVideoRef.current;
    const detector = qrDetectorRef.current;
    if (!video || !detector || !qrScanActive) return;
    detector
      .detect(video)
      .then((codes) => {
        if (Array.isArray(codes) && codes.length) {
          const token = String(codes[0]?.rawValue || "").trim();
          if (token) {
            setOtpQrToken(token);
            setQrScanError("");
            stopQrScanner();
            if (autoApprove && autoApproveOnQrScan && podMethod.includes("qr")) {
              submitPod({ qrTokenOverride: token, autoTriggered: true });
            }
            return;
          }
        }
        qrScanRafRef.current = requestAnimationFrame(() => scanQrLoop(autoApprove));
      })
      .catch((_err) => {
        qrScanRafRef.current = requestAnimationFrame(() => scanQrLoop(autoApprove));
      });
  };

  const startQrScanner = async () => {
    if (!("BarcodeDetector" in window)) {
      setQrScanError("QR scan is not supported in this browser. Use mobile Chrome/Edge.");
      return;
    }
    try {
      setQrScanError("");
      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      qrDetectorRef.current = detector;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      qrStreamRef.current = stream;
      if (qrVideoRef.current) {
        qrVideoRef.current.srcObject = stream;
        await qrVideoRef.current.play();
      }
      setQrScanActive(true);
      scanQrLoop(true);
    } catch (err) {
      setQrScanError(err?.message || "Unable to start QR scanner.");
      stopQrScanner();
    }
  };

  const isSlaRiskOrder = (entry) =>
    Boolean(
      entry?.sla?.breached
      || entry?.sla?.atRisk
      || Number(entry?.sla?.etaOverdueMinutes || 0) > 0
    );

  const buildNavigationLinks = (entry) => {
    const fromLat = Number(entry?.dispatchLastLocation?.lat ?? entry?.courierPosition?.lat);
    const fromLng = Number(entry?.dispatchLastLocation?.lng ?? entry?.courierPosition?.lng);
    const toLat = Number(entry?.destination?.lat ?? entry?.deliveryAddressSnapshot?.lat);
    const toLng = Number(entry?.destination?.lng ?? entry?.deliveryAddressSnapshot?.lng);
    if (!Number.isFinite(toLat) || !Number.isFinite(toLng)) return null;
    const toRaw = `${toLat},${toLng}`;
    const fromRaw = Number.isFinite(fromLat) && Number.isFinite(fromLng) ? `${fromLat},${fromLng}` : "";
    const google = fromRaw
      ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(fromRaw)}&destination=${encodeURIComponent(toRaw)}&travelmode=driving`
      : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(toRaw)}&travelmode=driving`;
    const apple = fromRaw
      ? `https://maps.apple.com/?saddr=${encodeURIComponent(fromRaw)}&daddr=${encodeURIComponent(toRaw)}&dirflg=d`
      : `https://maps.apple.com/?daddr=${encodeURIComponent(toRaw)}&dirflg=d`;
    return {
      google,
      apple,
    };
  };

  const openNavigation = (entry, provider = "google") => {
    const links = entry?.navigationLinks || buildNavigationLinks(entry);
    const url = provider === "apple" ? links?.apple : links?.google;
    if (!url) {
      setError("Destination coordinates are missing for navigation.");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const issueOtp = async () => {
    if (!selectedOrderId) {
      setError("Select an order first.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/dispatch/${selectedOrderId}/otp/issue`,
        method: "POST",
      });
      setSelectedOrder(data.order || null);
      setOtpMeta(data.otpMeta || null);
      setIssuedOtpPreview("");
      setMessage(`OTP issued | Notify: ${formatOtpDeliveryStatus(data.order || data.otpDelivery || null)}`);
      setError("");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const startCommSession = async () => {
    if (!selectedOrderId) {
      setError("Select an order first.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/dispatch/${selectedOrderId}/comm/session`,
        method: "POST",
      });
      setSelectedOrder(data.order || null);
      setCommSession(data.session || null);
      setMessage("Secure communication session started.");
      setError("");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const sendSecureTemplateMessage = async () => {
    if (!selectedOrderId) {
      setError("Select an order first.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/dispatch/${selectedOrderId}/comm/message`,
        method: "POST",
        body: {
          templateKey: String(messageTemplateKey || "").trim(),
          etaMinutes: Number(messageEtaMinutes || 10),
        },
      });
      setSelectedOrder(data.order || null);
      setMessage("Secure template message sent.");
      setError("");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const sendCustomSecureMessage = async () => {
    if (!selectedOrderId) {
      setError("Select an order first.");
      return;
    }
    const text = String(customSecureMessage || "").trim();
    if (!text) {
      setError("Enter a custom message.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/dispatch/${selectedOrderId}/comm/message`,
        method: "POST",
        body: {
          customText: text,
        },
      });
      setSelectedOrder(data.order || null);
      setCustomSecureMessage("");
      setMessage("Secure custom message sent.");
      setError("");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const saveJobChecklist = async () => {
    if (!selectedOrderId) {
      setError("Select an order first.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/dispatch/${selectedOrderId}/checklist`,
        method: "POST",
        body: {
          acknowledgements: {
            readInstructions: jobChecklist.readInstructions,
            confirmedAddress: jobChecklist.confirmedAddress,
            confirmedRecipient: jobChecklist.confirmedRecipient,
            askedGateCode: jobChecklist.askedGateCode,
            note: jobChecklist.note,
          },
        },
      });
      setSelectedOrder(data.order || null);
      setMessage(data.checklist?.completed ? "Checklist completed and saved." : "Checklist saved.");
      setError("");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const runSupervisorOverride = async () => {
    if (!selectedOrderId) {
      setError("Select an order first.");
      return;
    }
    if (!overrideReason.trim() || overrideReason.trim().length < 12) {
      setError("Override reason must be at least 12 characters.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/dispatch/${selectedOrderId}/supervisor-override`,
        method: "POST",
        body: {
          action: overrideAction,
          reason: overrideReason.trim(),
          courierId: overrideAction === "reassign" ? overrideCourierId.trim() || undefined : undefined,
        },
      });
      setSelectedOrder(data.order || null);
      if (data.otpMeta) setOtpMeta(data.otpMeta);
      setMessage(`Supervisor override applied: ${overrideAction}`);
      setError("");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const runDynamicReroute = async () => {
    if (!selectedOrderId) {
      setError("Select an order first.");
      return;
    }
    const lat = Number(locationLat);
    const lng = Number(locationLng);
    const body = Number.isFinite(lat) && Number.isFinite(lng) ? { location: { lat, lng } } : {};
    const path = `/api/dispatch/${selectedOrderId}/reroute`;
    if (!isOnline) {
      const queued = enqueueOfflineMutation({
        path,
        body,
        label: "reroute",
      });
      setMessage(`Offline: queued ${queued.label} action.`);
      setError("");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path,
        method: "POST",
        body,
      });
      setSelectedOrder(data.order || null);
      setLastReroute(data.reroute || null);
      setMessage(
        `Reroute applied: ETA ${formatEta(data.order?.dispatchEtaStart)} - ${formatEta(data.order?.dispatchEtaEnd)}`
      );
      setError("");
      await refresh();
    } catch (err) {
      if (shouldQueueOffline(err)) {
        enqueueOfflineMutation({
          path,
          body,
          label: "reroute",
        });
        setMessage("Offline detected: reroute queued.");
        setError("");
        return;
      }
      setError(err.message);
    }
  };

  const runUnsafeAction = async (action) => {
    if (!selectedOrderId) {
      setError("Select an order first.");
      return;
    }
    const reason = String(unsafeReason || "").trim();
    if (!reason || reason.length < 8) {
      setError("Unsafe reason must be at least 8 characters.");
      return;
    }
    await runCourierAction(
      "unsafe",
      {
        action,
        reason,
      },
      {
        allowOfflineQueue: true,
        label: `unsafe:${action}`,
      }
    );
  };

  const submitCourierLocation = async ({
    orderId = selectedOrderId,
    lat,
    lng,
    refreshAfter = true,
    silent = false,
    source = "manual",
  }) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      if (!silent) setError("Provide numeric latitude and longitude.");
      return;
    }
    const hasOrder = Boolean(String(orderId || "").trim());
    const path = hasOrder ? `/api/dispatch/${orderId}/location` : "/api/dispatch/courier/location";
    const locationBody = { lat, lng, source };
    if (!isOnline) {
      const queued = enqueueOfflineMutation({
        path,
        body: locationBody,
        label: `location ${lat.toFixed(4)},${lng.toFixed(4)}`,
      });
      setAutoLocationLastAt(new Date().toISOString());
      if (!silent) {
        setMessage(`Offline: queued ${queued.label}.`);
        setError("");
      }
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path,
        method: "POST",
        body: locationBody,
      });
      const locationPoint = data?.location || { lat, lng, at: new Date().toISOString() };
      if (hasOrder) {
        setSelectedOrder(data.order || null);
        setLiveMap((prev) => {
          const currentOrders = Array.isArray(prev?.orders) ? prev.orders : [];
          let matched = false;
          const nextOrders = currentOrders.map((entry) => {
            if (String(entry.id || "") !== String(orderId || "")) return entry;
            matched = true;
            const breadcrumbs = Array.isArray(entry.breadcrumbs) ? [...entry.breadcrumbs, locationPoint] : [locationPoint];
            return {
              ...entry,
              courierPosition: locationPoint,
              dispatchLastLocation: locationPoint,
              breadcrumbs: breadcrumbs.slice(-180),
            };
          });
          if (!matched && data?.order) {
            nextOrders.push({
              ...data.order,
              courierPosition: locationPoint,
              breadcrumbs: [locationPoint],
            });
          }
          return {
            ...prev,
            generatedAt: new Date().toISOString(),
            orders: nextOrders,
          };
        });
      }
      setAutoLocationLastAt(new Date().toISOString());
      setAutoLocationError("");
      if (!silent) {
        setMessage(`${hasOrder ? "Order" : "Presence"} location updated (${lat.toFixed(5)}, ${lng.toFixed(5)}) [${source}].`);
        setError("");
      }
      if (refreshAfter) await refresh();
    } catch (err) {
      if (shouldQueueOffline(err)) {
        enqueueOfflineMutation({
          path,
          body: locationBody,
          label: `location ${lat.toFixed(4)},${lng.toFixed(4)}`,
        });
        if (silent) setAutoLocationError("Offline: location queued for sync.");
        else {
          setMessage("Offline detected: location update queued.");
          setError("");
        }
        return;
      }
      if (silent) setAutoLocationError(err.message || "Auto location update failed.");
      else setError(err.message);
    }
  };

  const updateCourierLocation = async () => {
    const lat = Number(locationLat);
    const lng = Number(locationLng);
    await submitCourierLocation({ lat, lng, refreshAfter: true, silent: false, source: "manual" });
  };

  const pingDispatchLocation = async ({ silent = false, refreshAfter = false, source = "presence_manual" } = {}) => {
    if (!showCourierUI) return;
    if (!navigator.geolocation) {
      if (!silent) setError("Geolocation is not supported on this device.");
      return;
    }
    const getPosition = () =>
      new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 5000,
        });
      });
    try {
      const position = await getPosition();
      const lat = Number(position?.coords?.latitude);
      const lng = Number(position?.coords?.longitude);
      setLocationLat(Number.isFinite(lat) ? lat.toFixed(6) : "");
      setLocationLng(Number.isFinite(lng) ? lng.toFixed(6) : "");
      await submitCourierLocation({
        orderId: "",
        lat,
        lng,
        refreshAfter,
        silent,
        source,
      });
    } catch (err) {
      if (!silent) setError(err?.message || "Unable to read current location.");
    }
  };

  const submitPod = async ({ qrTokenOverride = "", autoTriggered = false } = {}) => {
    if (!selectedOrderId) {
      setError("Select an order first.");
      return;
    }
    const typedLat = Number(locationLat);
    const typedLng = Number(locationLng);
    const fallbackLat = Number(selectedOrder?.dispatchLastLocation?.lat ?? selectedOrder?.courierPosition?.lat);
    const fallbackLng = Number(selectedOrder?.dispatchLastLocation?.lng ?? selectedOrder?.courierPosition?.lng);
    const lat = Number.isFinite(typedLat) ? typedLat : fallbackLat;
    const lng = Number.isFinite(typedLng) ? typedLng : fallbackLng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setError("POD requires location. Update courier location first.");
      return;
    }
    if (!identityChecklistComplete) {
      setError("Complete the patient identity checklist before proof of delivery.");
      return;
    }
    if (podMethod.includes("photo") && !capturedPhotoData) {
      setError("Capture a delivery photo before submitting POD.");
      return;
    }
    if (podMethod.includes("signature") && !capturedSignatureData) {
      setError("Capture patient signature before submitting POD.");
      return;
    }
    if (podMethod.includes("otp") && !podMethod.includes("qr") && !otpValue.trim()) {
      setError("Enter OTP code before submitting POD.");
      return;
    }
    const qrToken = String(qrTokenOverride || otpQrToken || "").trim();
    if (podMethod.includes("qr") && !qrToken) {
      setError("Scan patient OTP QR before submitting POD.");
      return;
    }
    const payload = {
      method: podMethod,
      proof: podMethod.includes("otp") ? otpValue : podProof,
      otp: podMethod.includes("otp") && !podMethod.includes("qr") ? otpValue : undefined,
      otpQrToken: podMethod.includes("qr") ? qrToken : undefined,
      captureSource: "device_capture",
      identityChecklist: {
        confirmRecipientName: identityChecklist.confirmRecipientName,
        confirmAddress: identityChecklist.confirmAddress,
        confirmOrderId: identityChecklist.confirmOrderId,
        note: String(identityChecklist.note || "").trim() || undefined,
      },
      capturedMedia: {
        photoData: podMethod.includes("photo") ? capturedPhotoData : undefined,
        signatureData: podMethod.includes("signature") ? capturedSignatureData : undefined,
      },
      location: {
        lat,
        lng,
        accuracyMeters: Number.isFinite(Number(podAccuracyMeters)) ? Number(podAccuracyMeters) : undefined,
        capturedAt: new Date().toISOString(),
      },
    };
    await runCourierAction("pod", payload, {
      allowOfflineQueue: false,
      label: "pod",
    });
    if (!autoTriggered) {
      setOtpQrToken("");
      setCapturedPhotoData("");
      setCapturedPhotoName("");
      clearSignatureCapture();
    }
  };

  const centerOnCourierMarker = () => {
    const fallbackOrderId = showCourierUI
      ? String(myJobs?.[0]?.id || "")
      : String(selectedOrderId || "");
    const targetId = String(selectedOrderId || fallbackOrderId || "").trim();
    if (!targetId) {
      setError("Select an order to center map.");
      return;
    }
    setMapCenterOrderId(targetId);
    setMapCenterPoint(null);
    setMapCenterSignal((prev) => prev + 1);
    setError("");
  };

  const toggleCourierAvailability = async () => {
    if (!showCourierUI || !canCourierActions || availabilityBusy) return;
    const nextOnline = courierAvailability.online === false;
    setAvailabilityBusy(true);
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/dispatch/courier-availability/me",
        method: "POST",
        body: { online: nextOnline },
      });
      setCourierAvailability({
        online: data?.online !== false,
        updatedAt: data?.updatedAt || new Date().toISOString(),
        updatedBy: data?.updatedBy || null,
      });
      if (!nextOnline) {
        setAutoLocationEnabled(false);
      }
      setMessage(nextOnline ? "You are now online for dispatch assignments." : "You are now offline and hidden from assignment flow.");
      setError("");
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setAvailabilityBusy(false);
    }
  };

  const toggleOpsCourierAvailability = async (targetCourierId, nextOnline) => {
    if (!showOpsUI || !targetCourierId) return;
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/dispatch/couriers/${encodeURIComponent(targetCourierId)}/availability`,
        method: "POST",
        body: { online: !!nextOnline },
      });
      await loadCourierWorkload();
      await loadLiveMap();
      setMessage(nextOnline ? "Courier set online." : "Courier set offline.");
      setError("");
    } catch (err) {
      setError(err?.message || String(err));
    }
  };

  const focusCourierOnMap = async (targetCourierId, { setAsSelected = true } = {}) => {
    const cid = String(targetCourierId || "").trim();
    if (!cid) {
      setError("Select a courier first.");
      return;
    }
    const latestLiveMap = (await loadLiveMap()) || liveMap;
    await loadCourierWorkload();
    const mapOrders = Array.isArray(latestLiveMap?.orders) ? latestLiveMap.orders : [];
    const candidates = mapOrders.filter(
      (entry) => String(entry?.courierId || "").trim() === cid
    );
    const withCoords = candidates
      .filter((entry) => {
        const point = entry?.courierPosition || entry?.dispatchLastLocation || null;
        const lat = Number(point?.lat ?? point?.latitude);
        const lng = Number(point?.lng ?? point?.longitude);
        return Number.isFinite(lat) && Number.isFinite(lng);
      })
      .sort((a, b) => {
        const aMs = new Date(a?.courierPosition?.at || a?.dispatchLastLocation?.at || a?.updatedAt || 0).getTime() || 0;
        const bMs = new Date(b?.courierPosition?.at || b?.dispatchLastLocation?.at || b?.updatedAt || 0).getTime() || 0;
        return bMs - aMs;
      });
    const targetOrder = withCoords[0] || null;
    if (targetOrder) {
      if (setAsSelected) {
        setSelectedOrder(targetOrder);
        setOverrideCourierId(cid);
        await loadTimeline(targetOrder.id);
      }
      setCourierId(cid);
      setBatchCourierId(cid);
      setShowDeviationOnly(false);
      setMapCenterOrderId(String(targetOrder.id || ""));
      setMapCenterPoint(null);
      setMapCenterCourierId(cid);
      setMapCenterSignal((prev) => prev + 1);
      setMessage(`Centered map on ${targetOrder.courierName || cid}.`);
      setError("");
      return;
    }

    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/dispatch/couriers/${encodeURIComponent(cid)}/location`,
      });
      if (!data?.found || !data?.location) {
        setMessage(`No location ping yet for courier ${cid}. Ask courier to send/update location once.`);
        setError("");
        return;
      }
      const lat = Number(data?.location?.lat);
      const lng = Number(data?.location?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        setMessage(`No usable coordinates yet for courier ${cid}.`);
        setError("");
        return;
      }
      setCourierId(cid);
      setBatchCourierId(cid);
      setShowDeviationOnly(false);
      setMapCenterOrderId(String(data?.orderId || ""));
      setMapCenterPoint({ lat, lng });
      setMapCenterCourierId(cid);
      setMapCenterSignal((prev) => prev + 1);
      setMessage(`Centered map on latest courier ping (${cid}).`);
      setError("");
    } catch (err) {
      setError(err?.message || "Failed to load courier location.");
    }
  };

  const runAutoDispatch = async () => {
    if (!canOpsActions) return;
    if (!autoDispatchReason.trim() || autoDispatchReason.trim().length < 8) {
      setError("Auto-dispatch reason must be at least 8 characters.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/dispatch/auto-dispatch",
        method: "POST",
        body: { reason: autoDispatchReason.trim() },
      });
      setMessage(`Auto-dispatch complete. Assigned ${Number(data.assignments?.length || 0)} order(s).`);
      setError("");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const escalateSelectedOrder = async () => {
    if (!selectedOrderId) {
      setError("Select an order first.");
      return;
    }
    if (!escalationReason.trim() || escalationReason.trim().length < 8) {
      setError("Escalation reason must be at least 8 characters.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/dispatch/${selectedOrderId}/escalate`,
        method: "POST",
        body: { reason: escalationReason.trim() },
      });
      setSelectedOrder(data.order || null);
      setMessage("Order escalated to high priority.");
      setError("");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const escalateOrder = async (orderId) => {
    const targetOrderId = String(orderId || "").trim();
    if (!targetOrderId) {
      setError("Order id is required for escalation.");
      return;
    }
    const reason = escalationReason.trim() || "SLA breach immediate escalation.";
    if (reason.length < 8) {
      setError("Escalation reason must be at least 8 characters.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/dispatch/${targetOrderId}/escalate`,
        method: "POST",
        body: { reason },
      });
      setMessage(`Order ${targetOrderId} escalated.`);
      setError("");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const statusTone = (value) => {
    const status = String(value || "").toLowerCase();
    if (status === "delivered") return "ok";
    if (status === "failed") return "bad";
    if (status === "arrived") return "warn";
    if (["assigned", "accepted", "picked_up"].includes(status)) return "active";
    return "neutral";
  };

  const workloadTone = (band) => {
    const value = String(band || "").toLowerCase();
    if (value === "offline") return "bad";
    if (value === "critical") return "bad";
    if (value === "high") return "warn";
    if (value === "medium") return "active";
    if (value === "low") return "ok";
    return "neutral";
  };

  const toggleBatchOrder = (orderId) => {
    const id = String(orderId || "").trim();
    if (!id) return;
    setSelectedBatchOrderIds((prev) =>
      prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]
    );
  };

  const runBatchAction = async () => {
    if (!showOpsUI) return;
    if (!selectedBatchOrderIds.length) {
      setError("Select at least one order for batch action.");
      return;
    }
    if (!batchReason.trim() || batchReason.trim().length < 8) {
      setError("Batch reason must be at least 8 characters.");
      return;
    }
    if (batchAction === "assign" && !batchCourierId.trim()) {
      setError("Batch assign requires courier user ID.");
      return;
    }
    if (batchAction === "assign") {
      const target = opsCourierRoster.find(
        (entry) => String(entry.courierId || "") === String(batchCourierId.trim() || "")
      );
      if (target && target.online === false) {
        setError("Selected batch courier is offline. Choose an online courier.");
        return;
      }
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/dispatch/batch-action",
        method: "POST",
        body: {
          action: batchAction,
          reason: batchReason.trim(),
          orderIds: selectedBatchOrderIds,
          courierId: batchAction === "assign" ? batchCourierId.trim() : undefined,
          priority: batchAction === "set_priority" ? batchPriority : undefined,
        },
      });
      setMessage(
        `Batch ${data.action}: ${Number(data.success || 0)} succeeded, ${Number(data.failed || 0)} failed.`
      );
      setError("");
      setSelectedBatchOrderIds([]);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section
      className={`panel dispatch-hub ${useCourierLikeLayout ? "dispatch-hub--courier" : ""}${showOpsUI && !showCourierUI ? " dispatch-hub--ops-like" : ""}${showCourierUI && compactCourierMode ? " dispatch-hub--courier-compact" : ""}`}
    >
      <div className="dispatch-hub-header">
        <div>
          <h2>{showCourierUI && !showOpsUI ? "Courier Console" : "Dispatch Hub"}</h2>
          <div className="meta">
            {showCourierUI && !showOpsUI
              ? "Courier operations: jobs, location, ETA, POD"
              : "Live operations board for dispatchers and couriers"}
          </div>
          {showCourierUI ? (
            <div className="dispatch-identity-card">
              <span className="dispatch-identity-card__label">Courier Identity</span>
              <span className="dispatch-identity-card__value">{courierIdentity.fullName}</span>
              <span className="dispatch-identity-card__meta">
                User ID: {courierIdentity.userId} | Platform ID: {courierIdentity.platformStaffId}
              </span>
              <span className="dispatch-identity-card__meta">Email: {courierIdentity.email}</span>
              <span className="dispatch-identity-card__meta">
                Dispatch status:{" "}
                <strong>{courierAvailability.online ? "Online" : "Offline"}</strong>
                {courierAvailability.updatedAt
                  ? ` | Updated ${new Date(courierAvailability.updatedAt).toLocaleTimeString()}`
                  : ""}
              </span>
              <div className="form-row">
                <button
                  className={courierAvailability.online ? "ghost" : "primary"}
                  type="button"
                  onClick={toggleCourierAvailability}
                  disabled={!canCourierActions || availabilityBusy}
                >
                  {availabilityBusy
                    ? "Saving..."
                    : courierAvailability.online
                      ? "Go offline"
                      : "Go online"}
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => pingDispatchLocation({ silent: false, refreshAfter: true, source: "presence_manual" })}
                  disabled={!canCourierActions || courierAvailability.online === false}
                >
                  Ping dispatch location
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="dispatch-command-row form-row">
        {showOpsUI ? (
          <label>
            Queue status
            <select value={queueStatus} onChange={(e) => setQueueStatus(e.target.value)}>
              <option value="">All</option>
              <option value="queued">queued</option>
              <option value="assigned">assigned</option>
              <option value="accepted">accepted</option>
              <option value="picked_up">picked_up</option>
              <option value="arrived">arrived</option>
              <option value="delivered">delivered</option>
              <option value="failed">failed</option>
            </select>
          </label>
        ) : null}
        <label>
          Auto refresh
          <select
            value={`${autoRefreshEnabled ? autoRefreshSeconds : 0}`}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (value === 0) {
                setAutoRefreshEnabled(false);
                return;
              }
              setAutoRefreshEnabled(true);
              setAutoRefreshSeconds(value);
            }}
          >
            <option value="20">20s</option>
            <option value="10">10s</option>
            <option value="30">30s</option>
            <option value="60">60s</option>
            <option value="0">Off</option>
          </select>
        </label>
        <button
          className="ghost"
          type="button"
          onClick={() => refresh().catch((err) => setError(err?.message || "Failed to refresh dispatch data"))}
        >
          Refresh
        </button>
        {showCourierUI ? (
          <button
            className="ghost"
            type="button"
            onClick={() => setCompactCourierMode((prev) => !prev)}
          >
            {compactCourierMode ? "Standard mode" : "Compact mode"}
          </button>
        ) : null}
        </div>
      </div>

      <div className="dispatch-kpis">
        <article className="dispatch-kpi-card">
          <div className="dispatch-kpi-label">{showOpsUI ? "Visible Orders" : "My Jobs"}</div>
          <div className="dispatch-kpi-value">{showOpsUI ? dispatchSummary.total : myJobs.length}</div>
        </article>
        <article className="dispatch-kpi-card">
          <div className="dispatch-kpi-label">{showOpsUI ? "Queued" : "Active"}</div>
          <div className="dispatch-kpi-value">
            {showOpsUI
              ? dispatchSummary.queued
              : myJobs.filter((entry) => ["assigned", "accepted", "picked_up", "arrived"].includes(String(entry.dispatchStatus || "").toLowerCase())).length}
          </div>
        </article>
        <article className="dispatch-kpi-card">
          <div className="dispatch-kpi-label">{showOpsUI ? "Active" : "Delivered"}</div>
          <div className="dispatch-kpi-value">
            {showOpsUI
              ? dispatchSummary.active
              : myJobs.filter((entry) => String(entry.dispatchStatus || "").toLowerCase() === "delivered").length}
          </div>
        </article>
        <article className="dispatch-kpi-card">
          <div className="dispatch-kpi-label">{showOpsUI ? "Breached" : "Failed"}</div>
          <div className="dispatch-kpi-value">
            {showOpsUI
              ? Number(slaCockpit.summary?.breached || 0)
              : myJobs.filter((entry) => String(entry.dispatchStatus || "").toLowerCase() === "failed").length}
          </div>
        </article>
      </div>

      <div className="dispatch-sync-bar">
        <div className="meta">
          Sync: {isRefreshing ? "refreshing..." : "idle"} | Last sync:{" "}
          {lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString() : "n/a"}
        </div>
        <div className="meta">
          Network: {isOnline ? "online" : "offline"} | Queued actions: {offlineQueue.length}
        </div>
        <div className="form-row">
          <button className="ghost" type="button" onClick={flushOfflineQueue} disabled={!isOnline || isFlushingQueue || !offlineQueue.length}>
            {isFlushingQueue ? "Syncing..." : "Sync now"}
          </button>
          <button className="ghost" type="button" onClick={() => setShowOfflineInspector((prev) => !prev)}>
            {showOfflineInspector ? "Hide queue inspector" : "Open queue inspector"}
          </button>
        </div>
      </div>
      {showOfflineInspector ? (
        <div className="form dispatch-section-card dispatch-offline-inspector">
          <h3>Offline Queue Inspector</h3>
          <div className="meta">
            Pending actions: {offlineQueue.length} | Online: {isOnline ? "yes" : "no"}
          </div>
          {offlineQueue.length ? (
            <div className="form-row">
              <button
                className="ghost"
                type="button"
                onClick={() => setOfflineQueue([])}
              >
                Clear queued actions
              </button>
            </div>
          ) : null}
          <div className="queue">
            {offlineQueue.map((item) => (
              <article key={item.id} className="queue-card">
                <div className="queue-title">{item.label || item.path}</div>
                <div className="queue-meta">Path: {item.path}</div>
                <div className="queue-meta">
                  Created: {item.createdAt ? new Date(item.createdAt).toLocaleString() : "n/a"} | Retries:{" "}
                  {Number(item.retries || 0)} | Last tried:{" "}
                  {item.lastTriedAt ? new Date(item.lastTriedAt).toLocaleString() : "never"}
                </div>
                {item.lastError ? <div className="queue-meta">Last error: {item.lastError}</div> : null}
                <details>
                  <summary>Payload</summary>
                  <pre className="dispatch-offline-payload">
                    {JSON.stringify(item.body || {}, null, 2)}
                  </pre>
                </details>
                <div className="form-row">
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => retryOfflineItem(item)}
                    disabled={!isOnline || retryingOfflineId === item.id}
                  >
                    {retryingOfflineId === item.id ? "Retrying..." : "Retry now"}
                  </button>
                  <button className="ghost" type="button" onClick={() => removeOfflineItem(item.id)}>
                    Remove
                  </button>
                </div>
              </article>
            ))}
            {!offlineQueue.length ? <div className="meta">No queued offline actions.</div> : null}
          </div>
        </div>
      ) : null}
      {!isOnline ? (
        <p className="notice error dispatch-offline-banner">
          Offline mode active. Actions will be queued and synced once connection returns.
        </p>
      ) : null}
      {showCourierUI && (myJobsRiskSummary.breached > 0 || myJobsRiskSummary.atRisk > 0) ? (
        <p className="notice error dispatch-risk-summary">
          SLA risk on your jobs: {myJobsRiskSummary.breached} breached, {myJobsRiskSummary.atRisk} at-risk.
          Recommended: update ETA, run reroute, or use unsafe escalate/reassign if blocked.
        </p>
      ) : null}
      {breachAlert ? (
        <p className="notice error dispatch-breach-alert">
          {breachAlert}
        </p>
      ) : null}

      {showOpsUI ? (
      <div className="form dispatch-section-card dispatch-courier-left dispatch-ops-card dispatch-ops-batch">
        <h3>Batch Actions</h3>
        <div className="meta">
          Selected orders: {selectedBatchOrderIds.length}
        </div>
        <div className="form-row">
          <label>
            Action
            <select value={batchAction} onChange={(e) => setBatchAction(e.target.value)}>
              <option value="assign">assign</option>
              <option value="escalate">escalate</option>
              <option value="set_priority">set_priority</option>
            </select>
          </label>
          {batchAction === "assign" ? (
            <label>
              Courier user ID
              <input
                value={batchCourierId}
                onChange={(e) => setBatchCourierId(e.target.value)}
                placeholder="Courier user ID"
              />
            </label>
          ) : null}
          {batchAction === "set_priority" ? (
            <label>
              Priority
              <select value={batchPriority} onChange={(e) => setBatchPriority(e.target.value)}>
                <option value="low">low</option>
                <option value="normal">normal</option>
                <option value="high">high</option>
                <option value="urgent">urgent</option>
              </select>
            </label>
          ) : null}
          <label>
            Reason
            <input
              value={batchReason}
              onChange={(e) => setBatchReason(e.target.value)}
              placeholder="Why this batch action is needed"
            />
          </label>
          <button className="primary" type="button" onClick={runBatchAction}>
            Run batch action
          </button>
          <button
            className="ghost"
            type="button"
            onClick={() => setSelectedBatchOrderIds([])}
            disabled={!selectedBatchOrderIds.length}
          >
            Clear selection
          </button>
        </div>
      </div>
      ) : null}

      {showOpsUI ? (
      <div className="form dispatch-section-card dispatch-courier-left dispatch-courier-jobs dispatch-ops-card dispatch-ops-queue">
        <h3>Delivery Queue Board</h3>
        <div className="meta">
          Orders in view: {filteredQueue.length} | Selected: {selectedBatchOrderIds.length} | Active: {dispatchSummary.active}
        </div>
        <div className="queue dispatch-orders-grid">
          {filteredQueue.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`patient-record-card dispatch-order-card ${selectedOrderId === entry.id ? "active" : ""}`}
              onClick={() => {
                setSelectedOrder(entry);
                setCourierId(entry.courierId || "");
                setOverrideCourierId(entry.courierId || "");
                loadTimeline(entry.id);
              }}
            >
              <div className="patient-record-title">
                <input
                  type="checkbox"
                  checked={selectedBatchOrderIds.includes(String(entry.id || ""))}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleBatchOrder(entry.id)}
                  aria-label={`Select ${entry.id} for batch action`}
                />
                {entry.id}
                <span className={`dispatch-status-pill dispatch-status-pill--${statusTone(entry.dispatchStatus)}`}>
                  {entry.dispatchStatus || "none"}
                </span>
                <span className="dispatch-status-pill dispatch-status-pill--neutral">
                  {entry.orderStatus || "submitted"}
                </span>
              </div>
              <div className="meta">
                Patient: {entry.patientName || entry.patientId || "n/a"} | Courier: {entry.courierName || entry.courierId || "unassigned"}
              </div>
              <div className="meta">
                Destination: {entry.destinationAddress || "n/a"}
              </div>
              <div className="meta">
                Instructions: {entry.deliveryInstructions || "none"} | OTP notify: {formatOtpDeliveryStatus(entry)}
              </div>
            </button>
          ))}
          {!filteredQueue.length ? <div className="meta">No dispatch orders in this filter.</div> : null}
        </div>
      </div>
      ) : null}

      <div className={`form dispatch-actions-panel ${useCourierLikeLayout ? "dispatch-courier-sidebar" : ""}${showOpsUI && !showCourierUI ? " dispatch-ops-card dispatch-ops-console" : ""}`}>
        <h3>Action Console</h3>
        {showCourierUI ? (
          <div className="dispatch-active-pin">
            <div className="dispatch-active-pin__label">Active Job Pin</div>
            <div className="dispatch-active-pin__title">
              {pinnedActiveOrder?.id || "No active job selected"}
            </div>
            <div className="dispatch-active-pin__meta">
              {pinnedActiveOrder
                ? `${pinnedActiveOrder.patientName || pinnedActiveOrder.patientId || "Unknown patient"} | ${pinnedActiveOrder.dispatchStatus || "none"}`
                : "Select a job to pin it here."}
            </div>
            {pinnedActiveOrder ? (
              <div className="dispatch-active-pin__meta">
                {pinnedActiveOrder.destinationAddress || "No destination"} | Last ping:{" "}
                {formatLocationAge(pinnedActiveOrder)}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="meta">Selected order: {selectedOrderId || "none"}</div>
        {selectedOrder ? (
          <div className="meta">
            Current ETA: {formatEta(selectedOrder.dispatchEtaStart)} - {formatEta(selectedOrder.dispatchEtaEnd)}
          </div>
        ) : null}
        {selectedOrder ? (
          <div className="meta">
            Destination: {selectedOrder.destinationAddress || "Not provided by patient yet"}
          </div>
        ) : null}
        {selectedOrder ? (
          <div className="meta">
            Delivery instructions: {selectedOrder.deliveryInstructions || "No special instructions"}
          </div>
        ) : null}
        {selectedOrder ? <div className="meta">Last location ping: {formatLocationAge(selectedOrder)}</div> : null}
        {selectedOrder ? <div className="meta">OTP notify: {formatOtpDeliveryStatus(selectedOrder)}</div> : null}
        {showOpsUI && selectedOpsCourierEntry ? (
          <div className="meta">
            Courier availability:{" "}
            <strong>{selectedOpsCourierEntry.online ? "Online" : "Offline"}</strong>
            {selectedOpsCourierEntry.online ? "" : " | Assignment is blocked until courier goes online."}
          </div>
        ) : null}
        {selectedOrder && isSlaRiskOrder(selectedOrder) ? (
          <div className="meta dispatch-risk-recommendation">
            Recommended action: update ETA, run dynamic reroute, and use unsafe escalate if destination is blocked.
          </div>
        ) : null}
        <details
          className="dispatch-console-block dispatch-console-collapsible"
          open={consolePanelOpen.controls}
          onToggle={(e) => updateConsolePanelOpen("controls", e.currentTarget.open)}
        >
          <summary className="dispatch-console-summary">
            <h4>Courier Controls</h4>
          </summary>
          <div className="dispatch-console-body">
          <label className="dispatch-field dispatch-field--full">
            Courier user ID
            {showOpsUI ? (
              <select
                value={courierId}
                onChange={(e) => {
                  const value = String(e.target.value || "");
                  setCourierId(value);
                  setBatchCourierId(value);
                }}
              >
                <option value="">Select courier</option>
                {opsCourierRoster.map((entry) => (
                  <option key={`ops-courier-opt-${entry.courierId}`} value={entry.courierId}>
                    {entry.courierName} ({entry.courierId}) Â· {entry.availability} Â· active {entry.activeJobs}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={courierId}
                onChange={(e) => setCourierId(e.target.value)}
                placeholder={showCourierUI ? courierIdentity.userId : "Courier user ID"}
                readOnly={showCourierUI && !showOpsUI}
              />
            )}
            {showCourierUI && !showOpsUI ? (
              <span className="meta">Locked to logged-in courier identity.</span>
            ) : null}
            {showOpsUI ? (
              <span className="meta">
                Couriers in scope: {opsCourierRoster.length}. Select an available courier to assign quickly.
              </span>
            ) : null}
          </label>
          {showOpsUI ? (
            <div className="dispatch-courier-roster dispatch-field dispatch-field--full">
              <div className="dispatch-courier-roster__title">Courier Roster</div>
              <div className="dispatch-courier-roster__list">
                {opsCourierRoster.map((entry) => (
                  <article key={`ops-courier-row-${entry.courierId}`} className="dispatch-courier-roster__row">
                    <label className="dispatch-courier-roster__pick">
                      <input
                        type="radio"
                        name="dispatch-courier-select"
                        checked={String(courierId || "") === String(entry.courierId || "")}
                        onChange={() => {
                          setCourierId(entry.courierId);
                          setBatchCourierId(entry.courierId);
                        }}
                      />
                      <span>
                        {entry.courierName} <span className={`dispatch-status-pill dispatch-status-pill--${workloadTone(entry.loadBand)}`}>{entry.availability}</span>
                      </span>
                    </label>
                    <div className="dispatch-courier-roster__meta">
                      {entry.zone || "n/a"} | Active {entry.activeJobs} | Overdue {entry.overdueJobs}
                    </div>
                    <button
                      className="ghost"
                      type="button"
                      onClick={() => focusCourierOnMap(entry.courierId)}
                    >
                      View courier location
                    </button>
                  </article>
                ))}
                {!opsCourierRoster.length ? <div className="meta">No courier roster in scope yet.</div> : null}
              </div>
            </div>
          ) : null}
          <div className="form-row dispatch-console-grid">
            {showOpsUI ? (
            <button
              className="primary dispatch-btn dispatch-span-2"
              type="button"
              onClick={assign}
              disabled={!canOpsActions || !courierId.trim() || (selectedOpsCourierEntry?.online === false)}
            >
              Assign courier
            </button>
            ) : null}
            {showCourierUI ? (
              <>
            <button
              className="ghost dispatch-btn dispatch-span-2"
              type="button"
              onClick={() => runCourierAction("accept")}
              disabled={!canCourierActions}
            >
              Accept
            </button>
            <button
              className="ghost dispatch-btn dispatch-span-2"
              type="button"
              onClick={() => runCourierAction("pickup", { pickupNote: "Collected by courier" })}
              disabled={!canCourierActions}
            >
              Pickup
            </button>
            <button
              className="ghost dispatch-btn dispatch-span-2"
              type="button"
              onClick={() => runCourierAction("arrived")}
              disabled={!canCourierActions}
            >
              Arrived
            </button>
            <label className="dispatch-field dispatch-span-2">
              Lat
              <input value={locationLat} onChange={(e) => setLocationLat(e.target.value)} placeholder="6.9271" />
            </label>
            <label className="dispatch-field dispatch-span-2">
              Lng
              <input value={locationLng} onChange={(e) => setLocationLng(e.target.value)} placeholder="79.8612" />
            </label>
            <button className="ghost dispatch-btn dispatch-span-3" type="button" onClick={updateCourierLocation} disabled={!canCourierActions}>
              Update location
            </button>
            <button
              className="ghost dispatch-btn dispatch-span-3"
              type="button"
              onClick={() => openNavigation(selectedOrder || {}, "google")}
              disabled={!canCourierActions || !selectedOrderId}
            >
              Open Google Maps
            </button>
            <button
              className="ghost dispatch-btn dispatch-span-3"
              type="button"
              onClick={() => openNavigation(selectedOrder || {}, "apple")}
              disabled={!canCourierActions || !selectedOrderId}
            >
              Open Apple Maps
            </button>
            <button
              className="ghost dispatch-btn dispatch-span-3"
              type="button"
              onClick={() => {
                setAutoLocationEnabled((prev) => !prev);
                setAutoLocationError("");
              }}
              disabled={!( (canCourierActions || canOpsActions) && selectedOrderId )}
            >
              {autoLocationEnabled ? "Stop Auto Location" : "Start Auto Location"}
            </button>
            <a
              className="ghost dispatch-btn dispatch-span-3 dispatch-link-btn"
              href={`tel:${emergencyPhone}`}
            >
              Emergency call ({emergencyPhone})
            </a>
            <a
              className="ghost dispatch-btn dispatch-span-3 dispatch-link-btn"
              href={`tel:${dispatchHotline}`}
            >
              Dispatch hotline
              </a>
              </>
            ) : null}
          </div>
          </div>
        </details>
        {showCourierUI || showOpsUI ? (
          <div className="meta">
            Auto location: {autoLocationEnabled ? "on" : "off"} | Last ping:{" "}
            {autoLocationLastAt ? new Date(autoLocationLastAt).toLocaleTimeString() : "n/a"}
            {autoLocationError ? ` | Error: ${autoLocationError}` : ""}
          </div>
        ) : null}
        {showCourierUI && selectedOrder && isSlaRiskOrder(selectedOrder) ? (
          <div className="notice error dispatch-risk-notice">
            ETA risk detected for this job. Use dynamic reroute to refresh ETA and route links.
            <button className="ghost" type="button" onClick={runDynamicReroute}>
              Dynamic reroute
            </button>
          </div>
        ) : null}
        {showCourierUI && lastReroute ? (
          <div className="meta">
            Reroute: {lastReroute.reason || "route refreshed"} | Distance:{" "}
            {Number(lastReroute.distanceMeters || 0)}m | ETA:{" "}
            {Number(lastReroute.etaMinutes || 0)}m
          </div>
        ) : null}
        {showCourierUI ? (
        <details
          className="dispatch-console-block dispatch-console-collapsible"
          open={consolePanelOpen.eta}
          onToggle={(e) => updateConsolePanelOpen("eta", e.currentTarget.open)}
        >
          <summary className="dispatch-console-summary">
            <h4>ETA Block</h4>
          </summary>
          <div className="dispatch-console-body">
          <div className="form-row dispatch-console-grid">
            <label className="dispatch-field dispatch-span-4">
              ETA start
              <input
                type="datetime-local"
                value={etaStart}
                onChange={(e) => setEtaStart(e.target.value)}
              />
            </label>
            <label className="dispatch-field dispatch-span-4">
              ETA end
              <input
                type="datetime-local"
                value={etaEnd}
                onChange={(e) => setEtaEnd(e.target.value)}
              />
            </label>
            <button
              className="ghost dispatch-btn dispatch-span-4"
              type="button"
              onClick={() =>
                runCourierAction("eta", {
                  etaStart: toIsoOrNull(etaStart) || undefined,
                  etaEnd: toIsoOrNull(etaEnd) || undefined,
                })
              }
              disabled={!canCourierActions}
            >
              Update ETA
            </button>
          </div>
          </div>
        </details>
        ) : null}
        {showCourierUI ? (
        <details
          className="dispatch-console-block dispatch-console-collapsible"
          open={consolePanelOpen.pod}
          onToggle={(e) => updateConsolePanelOpen("pod", e.currentTarget.open)}
        >
          <summary className="dispatch-console-summary">
            <h4>POD / OTP Block</h4>
          </summary>
          <div className="dispatch-console-body">
          <div className="form-row dispatch-console-grid">
            <label className="dispatch-field dispatch-span-2">
              POD method
              <select value={podMethod} onChange={(e) => setPodMethod(e.target.value)}>
                <option value="otp">otp</option>
                <option value="otp_photo">otp + photo</option>
                <option value="otp_photo_signature">otp + photo + signature</option>
                <option value="otp_qr">otp qr scan</option>
                <option value="otp_qr_photo_signature">otp qr + photo + signature</option>
                <option value="signature">signature</option>
                <option value="photo">photo</option>
                <option value="photo_signature">photo + signature</option>
              </select>
            </label>
            <label className="dispatch-field dispatch-span-3">
              Proof/note
              <input value={podProof} onChange={(e) => setPodProof(e.target.value)} />
            </label>
            {podMethod.includes("otp") && !podMethod.includes("qr") ? (
              <label className="dispatch-field dispatch-span-3">
                OTP code
                <input value={otpValue} onChange={(e) => setOtpValue(e.target.value)} placeholder="Enter OTP" />
              </label>
            ) : null}
            {podMethod.includes("qr") ? (
              <>
                <label className="dispatch-field dispatch-span-4">
                  OTP QR token
                  <input
                    value={otpQrToken}
                    onChange={(e) => setOtpQrToken(e.target.value)}
                    placeholder="Scan from patient QR"
                  />
                </label>
                <div className="dispatch-qr-scan-wrap dispatch-span-4">
                  <video ref={qrVideoRef} className="dispatch-qr-video" muted playsInline />
                  <div className="form-row">
                    <button className="ghost" type="button" onClick={startQrScanner} disabled={qrScanActive}>
                      Start QR scan
                    </button>
                    <button className="ghost" type="button" onClick={stopQrScanner} disabled={!qrScanActive}>
                      Stop scan
                    </button>
                    <label className="dispatch-map-toggle">
                      <input
                        type="checkbox"
                        checked={autoApproveOnQrScan}
                        onChange={(e) => setAutoApproveOnQrScan(e.target.checked)}
                      />
                      Auto-approve on scan
                    </label>
                  </div>
                  {qrScanError ? <div className="meta">{qrScanError}</div> : null}
                </div>
              </>
            ) : null}
            {podMethod.includes("photo") ? (
              <div className="dispatch-capture-wrap dispatch-span-4">
                <label className="dispatch-field">
                  Capture photo (camera/file)
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handlePhotoCaptureFile}
                  />
                </label>
                {capturedPhotoData ? (
                  <div className="dispatch-capture-preview">
                    <img src={capturedPhotoData} alt="Captured POD" />
                    <div className="meta">{capturedPhotoName || "captured-photo"} | locked to capture</div>
                  </div>
                ) : (
                  <div className="meta">No photo captured yet.</div>
                )}
              </div>
            ) : null}
            {podMethod.includes("signature") ? (
              <div className="dispatch-signature-wrap dispatch-span-4">
                <div className="meta">Patient signature capture</div>
                <canvas
                  ref={signatureCanvasRef}
                  className="dispatch-signature-canvas"
                  onPointerDown={startSignatureStroke}
                  onPointerMove={continueSignatureStroke}
                  onPointerUp={endSignatureStroke}
                  onPointerLeave={endSignatureStroke}
                />
                <div className="form-row">
                  <button className="ghost" type="button" onClick={clearSignatureCapture}>
                    Clear signature
                  </button>
                  <span className="meta">
                    {capturedSignatureData ? "Signature captured and locked." : "Draw signature above."}
                  </span>
                </div>
              </div>
            ) : null}
            <label className="dispatch-field dispatch-span-2">
              Geo accuracy (m)
              <input
                value={podAccuracyMeters}
                onChange={(e) => setPodAccuracyMeters(e.target.value)}
                placeholder="15"
              />
            </label>
            <div className="dispatch-id-checklist dispatch-span-4">
              <div className="meta"><strong>Patient identity checklist (required)</strong></div>
              <label className="dispatch-map-toggle">
                <input
                  type="checkbox"
                  checked={identityChecklist.confirmRecipientName}
                  onChange={(e) =>
                    setIdentityChecklist((prev) => ({ ...prev, confirmRecipientName: e.target.checked }))
                  }
                />
                Confirm recipient name matches order
              </label>
              <label className="dispatch-map-toggle">
                <input
                  type="checkbox"
                  checked={identityChecklist.confirmAddress}
                  onChange={(e) =>
                    setIdentityChecklist((prev) => ({ ...prev, confirmAddress: e.target.checked }))
                  }
                />
                Confirm delivery address/handoff location
              </label>
              <label className="dispatch-map-toggle">
                <input
                  type="checkbox"
                  checked={identityChecklist.confirmOrderId}
                  onChange={(e) =>
                    setIdentityChecklist((prev) => ({ ...prev, confirmOrderId: e.target.checked }))
                  }
                />
                Confirm order ID with patient
              </label>
              <label className="dispatch-field">
                Checklist note (optional)
                <input
                  value={identityChecklist.note}
                  onChange={(e) => setIdentityChecklist((prev) => ({ ...prev, note: e.target.value }))}
                  placeholder="Any identity or handoff note"
                />
              </label>
            </div>
            <button
              className="primary dispatch-btn dispatch-span-2"
              type="button"
              onClick={submitPod}
              disabled={!canCourierActions || !identityChecklistComplete}
            >
              Proof of delivery
            </button>
            <button
              className="ghost dispatch-btn dispatch-span-2"
              type="button"
              onClick={issueOtp}
              disabled={!selectedOrderId}
            >
              Issue OTP
            </button>
          </div>
          </div>
        </details>
        ) : null}
        {otpMeta ? (
          <div className="meta">
            OTP issued: {otpMeta.issuedAt ? new Date(otpMeta.issuedAt).toLocaleString() : "n/a"} | Expires:{" "}
            {otpMeta.expiresAt ? new Date(otpMeta.expiresAt).toLocaleString() : "n/a"} | Attempts:{" "}
            {Number(otpMeta.attempts || 0)}/{Number(otpMeta.maxAttempts || 0)} | Locked:{" "}
            {otpMeta.locked ? "yes" : "no"}
          </div>
        ) : null}
        {selectedOrder?.deliveryOtp?.qrToken ? (
          <div className="meta">OTP QR token issued for patient handoff flow.</div>
        ) : null}
        {false && issuedOtpPreview ? <div className="meta">Issued OTP (debug): {issuedOtpPreview}</div> : null}
        {selectedOrder?.deliveryProof?.podHash ? (
          <div className="meta">POD hash (tamper-evident): {selectedOrder.deliveryProof.podHash}</div>
        ) : null}
        {showCourierUI ? (
        <details
          className="dispatch-console-block dispatch-console-collapsible"
          open={consolePanelOpen.exceptions}
          onToggle={(e) => updateConsolePanelOpen("exceptions", e.currentTarget.open)}
        >
          <summary className="dispatch-console-summary">
            <h4>Exceptions Block</h4>
          </summary>
          <div className="dispatch-console-body">
          <div className="form-row dispatch-console-grid">
            <label className="dispatch-field dispatch-span-4">
              Unsafe situation note
              <input
                value={unsafeReason}
                onChange={(e) => setUnsafeReason(e.target.value)}
                placeholder="Describe the safety issue or reason"
              />
            </label>
            <button
              className="ghost dispatch-btn dispatch-span-2"
              type="button"
              onClick={() => runUnsafeAction("pause")}
              disabled={!canCourierActions}
            >
              Unsafe: pause
            </button>
            <button
              className="ghost dispatch-btn dispatch-span-2"
              type="button"
              onClick={() => runUnsafeAction("escalate")}
              disabled={!canCourierActions}
            >
              Unsafe: escalate
            </button>
            <button
              className="ghost dispatch-btn dispatch-span-2"
              type="button"
              onClick={() => runUnsafeAction("reassign")}
              disabled={!canCourierActions}
            >
              Unsafe: reassign
            </button>
            <label className="dispatch-field dispatch-span-4">
              Fail reason
              <select value={failReason} onChange={(e) => setFailReason(e.target.value)}>
                <option value="no_answer">no_answer</option>
                <option value="wrong_address">wrong_address</option>
                <option value="patient_unavailable">patient_unavailable</option>
                <option value="safety_issue">safety_issue</option>
                <option value="other">other</option>
              </select>
            </label>
            <button
              className="ghost dispatch-btn dispatch-span-3"
              type="button"
                onClick={() => runCourierAction("fail", { reason: failReason })}
                disabled={!canCourierActions}
              >
                Mark failed
              </button>
          </div>
          </div>
        </details>
        ) : null}
        {showCourierUI ? (
        <details
          className="dispatch-console-block dispatch-console-collapsible"
          open={consolePanelOpen.communication}
          onToggle={(e) => updateConsolePanelOpen("communication", e.currentTarget.open)}
        >
          <summary className="dispatch-console-summary">
            <h4>Communication</h4>
          </summary>
          <div className="dispatch-console-body">
          <div className="form-row dispatch-console-grid">
            <button
              className="ghost dispatch-btn dispatch-span-4"
              type="button"
              onClick={startCommSession}
              disabled={!canCourierActions || !selectedOrderId}
            >
              Start masked session
            </button>
            {commSession ? (
              <div className="dispatch-span-4">
                <div className="meta">
                  Masked call: {commSession?.masked?.phone || "n/a"} | Email: {commSession?.masked?.email || "n/a"}
                </div>
                <div className="meta">Chat handle: {commSession?.masked?.chatHandle || "n/a"}</div>
              </div>
            ) : (
              <div className="meta dispatch-span-4">No active session yet.</div>
            )}
            <label className="dispatch-field dispatch-span-2">
              Template
              <select value={messageTemplateKey} onChange={(e) => setMessageTemplateKey(e.target.value)}>
                {(messageTemplates || []).map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label || entry.key}
                  </option>
                ))}
                {!messageTemplates.length ? <option value="arriving_10">arriving_10</option> : null}
              </select>
            </label>
            <label className="dispatch-field dispatch-span-2">
              ETA min
              <input value={messageEtaMinutes} onChange={(e) => setMessageEtaMinutes(e.target.value)} placeholder="10" />
            </label>
            <button
              className="ghost dispatch-btn dispatch-span-2"
              type="button"
              onClick={sendSecureTemplateMessage}
              disabled={!canCourierActions || !selectedOrderId}
            >
              Send template
            </button>
            <label className="dispatch-field dispatch-span-4">
              Custom secure message
              <input
                value={customSecureMessage}
                onChange={(e) => setCustomSecureMessage(e.target.value)}
                placeholder="Type a secure message to patient"
              />
            </label>
            <button
              className="ghost dispatch-btn dispatch-span-2"
              type="button"
              onClick={sendCustomSecureMessage}
              disabled={!canCourierActions || !selectedOrderId}
            >
              Send custom
            </button>
          </div>
          </div>
        </details>
        ) : null}
        {showCourierUI ? (
        <details
          className="dispatch-console-block dispatch-console-collapsible"
          open={consolePanelOpen.checklist}
          onToggle={(e) => updateConsolePanelOpen("checklist", e.currentTarget.open)}
        >
          <summary className="dispatch-console-summary">
            <h4>Instruction Checklist</h4>
          </summary>
          <div className="dispatch-console-body">
          <div className="dispatch-id-checklist">
            <label className="dispatch-map-toggle">
              <input
                type="checkbox"
                checked={jobChecklist.readInstructions}
                onChange={(e) => setJobChecklist((prev) => ({ ...prev, readInstructions: e.target.checked }))}
              />
              Read delivery instructions
            </label>
            <label className="dispatch-map-toggle">
              <input
                type="checkbox"
                checked={jobChecklist.confirmedAddress}
                onChange={(e) => setJobChecklist((prev) => ({ ...prev, confirmedAddress: e.target.checked }))}
              />
              Confirm address with patient
            </label>
            <label className="dispatch-map-toggle">
              <input
                type="checkbox"
                checked={jobChecklist.confirmedRecipient}
                onChange={(e) => setJobChecklist((prev) => ({ ...prev, confirmedRecipient: e.target.checked }))}
              />
              Confirm recipient identity
            </label>
            <label className="dispatch-map-toggle">
              <input
                type="checkbox"
                checked={jobChecklist.askedGateCode}
                onChange={(e) => setJobChecklist((prev) => ({ ...prev, askedGateCode: e.target.checked }))}
              />
              Asked gate/building code (if required)
            </label>
            <label className="dispatch-field">
              Note
              <input
                value={jobChecklist.note}
                onChange={(e) => setJobChecklist((prev) => ({ ...prev, note: e.target.value }))}
                placeholder="Checklist note"
              />
            </label>
            <button className="ghost" type="button" onClick={saveJobChecklist} disabled={!canCourierActions || !selectedOrderId}>
              Save checklist
            </button>
          </div>
          </div>
        </details>
        ) : null}
      </div>

      {showCourierUI ? (
        <div className="form dispatch-section-card dispatch-courier-left dispatch-courier-jobs">
          <h3>Courier Scorecard</h3>
          <div className="meta">
            Day: {scorecard?.day || "n/a"} | Assigned: {Number(scorecard?.assigned || 0)} | Delivered:{" "}
            {Number(scorecard?.delivered || 0)} | Failed: {Number(scorecard?.failed || 0)}
          </div>
          <div className="dispatch-kpis">
            <article className="dispatch-kpi-card">
              <div className="dispatch-kpi-label">On-time %</div>
              <div className="dispatch-kpi-value">{Number(scorecard?.onTimeRate || 0)}%</div>
            </article>
            <article className="dispatch-kpi-card">
              <div className="dispatch-kpi-label">Completion %</div>
              <div className="dispatch-kpi-value">{Number(scorecard?.completionRate || 0)}%</div>
            </article>
            <article className="dispatch-kpi-card">
              <div className="dispatch-kpi-label">Exception %</div>
              <div className="dispatch-kpi-value">{Number(scorecard?.exceptionRate || 0)}%</div>
            </article>
            <article className="dispatch-kpi-card">
              <div className="dispatch-kpi-label">Checklist %</div>
              <div className="dispatch-kpi-value">{Number(scorecard?.checklistCompletionRate || 0)}%</div>
            </article>
          </div>
          <div className="queue">
            {(coachingPrompts || []).map((prompt) => (
              <article key={`coach-${prompt.id || prompt.message}`} className="queue-card">
                <div className="queue-title">Coaching prompt</div>
                <div className="queue-meta">{prompt.message || "Follow checklist and ETA hygiene."}</div>
              </article>
            ))}
            {!coachingPrompts.length ? <div className="meta">No coaching prompts right now.</div> : null}
          </div>
        </div>
      ) : null}

      {showCourierUI ? (
        <div className="form dispatch-section-card dispatch-courier-left dispatch-courier-stops">
          <h3>My Jobs</h3>
          <div className="queue">
            {myJobs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`patient-record-card ${selectedOrderId === entry.id ? "active" : ""}`}
                onClick={() => {
                  setSelectedOrder(entry);
                  setOverrideCourierId(entry.courierId || "");
                  loadTimeline(entry.id);
                }}
              >
                <div className="patient-record-title">
                  {entry.id} | {entry.dispatchStatus || "none"}
                </div>
                <div className="meta">{entry.patientName || entry.patientId || "Unknown patient"}</div>
                <div className="meta">
                  SLA: {formatSlaCountdown(entry)}
                  {entry?.sla?.atRisk ? " | at-risk" : ""}
                  {entry?.sla?.breached ? " | breached" : ""}
                </div>
                {isSlaRiskOrder(entry) ? (
                  <div className="meta dispatch-risk-recommendation">
                    Recommended: update ETA or reroute now.
                  </div>
                ) : null}
              </button>
            ))}
            {!myJobs.length ? <div className="meta">No assigned courier jobs.</div> : null}
          </div>
        </div>
      ) : null}

      {showCourierUI ? (
        <div className="form dispatch-section-card dispatch-courier-left dispatch-courier-next">
          <h3>Next Best Stops</h3>
          <div className="meta">
            Suggested sequence for multi-drop jobs | Updated:{" "}
            {nextStops.generatedAt ? new Date(nextStops.generatedAt).toLocaleTimeString() : "n/a"}
          </div>
          <div className="queue">
            {(nextStops.stops || []).map((entry) => (
              <article key={`next-${entry.id}`} className="queue-card dispatch-next-card">
                <div className="queue-title">
                  #{Number(entry.sequenceRank || 0)} {entry.id}
                  <span className={`dispatch-status-pill dispatch-status-pill--${statusTone(entry.dispatchStatus)}`}>
                    {entry.dispatchStatus || "none"}
                  </span>
                </div>
                <div className="queue-meta">
                  Score: {Number(entry.sequenceScore || 0)} | Distance:{" "}
                  {Number.isFinite(Number(entry.distanceMeters)) ? `${Number(entry.distanceMeters)}m` : "n/a"} | Suggested ETA:{" "}
                  {Number.isFinite(Number(entry.suggestedEtaMinutes)) ? `${Number(entry.suggestedEtaMinutes)}m` : "n/a"}
                </div>
                <div className="queue-meta">
                  {entry.patientName || entry.patientId || "Patient"} | {entry.destinationAddress || "No destination"}
                </div>
                <div className="form-row">
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => {
                      setSelectedOrder(entry);
                      setOverrideCourierId(entry.courierId || "");
                      loadTimeline(entry.id);
                    }}
                  >
                    Select
                  </button>
                  <button className="ghost" type="button" onClick={() => openNavigation(entry, "google")}>
                    Navigate
                  </button>
                </div>
              </article>
            ))}
            {!nextStops.stops?.length ? <div className="meta">No active multi-drop suggestions.</div> : null}
          </div>
        </div>
      ) : null}

      {showOpsUI ? (
        <div className="form dispatch-section-card dispatch-courier-left dispatch-courier-stops dispatch-ops-card dispatch-ops-workload">
          <h3>Courier Workload Heatmap</h3>
          <div className="meta">
            Couriers: {Number(courierWorkload.summary?.couriers || 0)} | Active jobs:{" "}
            {Number(courierWorkload.summary?.activeJobs || 0)} | Overdue jobs:{" "}
            {Number(courierWorkload.summary?.overdueJobs || 0)} | Updated:{" "}
            {courierWorkload.generatedAt ? new Date(courierWorkload.generatedAt).toLocaleTimeString() : "n/a"}
          </div>
          <div className="queue">
            {(courierWorkload.couriers || []).map((entry) => (
              <article key={`wl-${entry.courierId}`} className="queue-card">
                <div>
                  <div className="queue-title">
                    {entry.courierName || entry.courierId}
                    <span className={`dispatch-status-pill dispatch-status-pill--${workloadTone(entry.loadBand)}`}>
                      {entry.loadBand || "idle"}
                    </span>
                  </div>
                  <div className="queue-meta">
                    Zone: {entry.zone || "n/a"} | Active: {Number(entry.activeJobs || 0)} | Overdue:{" "}
                    {Number(entry.overdueJobs || 0)} | Total assigned: {Number(entry.assignedTotal || 0)}
                  </div>
                  <div className="queue-meta">
                    Last assigned: {entry.lastAssignedAt ? new Date(entry.lastAssignedAt).toLocaleString() : "n/a"}
                  </div>
                  <div className="queue-actions">
                    <span className="meta">Status: {entry.online === false ? "offline" : "online"}</span>
                    {showOpsUI ? (
                      <>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => focusCourierOnMap(entry.courierId)}
                        >
                          Locate
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => toggleOpsCourierAvailability(entry.courierId, !(entry.online !== false))}
                        >
                          {entry.online === false ? "Set online" : "Set offline"}
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
            {!courierWorkload.couriers?.length ? <div className="meta">No courier workload data yet.</div> : null}
          </div>
        </div>
      ) : null}

      {showOpsUI ? (
        <div className="form dispatch-section-card dispatch-courier-left dispatch-ops-card dispatch-ops-autodispatch">
          <h3>Smart Auto-Dispatch</h3>
          <label>
            Run reason (required)
            <input
              value={autoDispatchReason}
              onChange={(e) => setAutoDispatchReason(e.target.value)}
              placeholder="Explain why auto-dispatch is being run"
            />
          </label>
          <button className="primary" type="button" onClick={runAutoDispatch}>
            Run auto-dispatch
          </button>
        </div>
      ) : null}

      {showOpsUI ? (
        <div className="form dispatch-section-card dispatch-courier-left dispatch-ops-card dispatch-ops-sla">
          <h3>Dispatch SLA Cockpit</h3>
          <div className="meta">
            Active: {Number(slaCockpit.summary?.active || 0)} | Breached:{" "}
            {Number(slaCockpit.summary?.breached || 0)} | At risk: {Number(slaCockpit.summary?.atRisk || 0)} | Updated:{" "}
            {slaCockpit.generatedAt ? new Date(slaCockpit.generatedAt).toLocaleString() : "n/a"}
          </div>
          <label>
            Escalation reason
            <input
              value={escalationReason}
              onChange={(e) => setEscalationReason(e.target.value)}
              placeholder="Reason for one-click escalation"
            />
          </label>
          <button className="ghost" type="button" onClick={escalateSelectedOrder} disabled={!selectedOrderId}>
            Escalate selected order
          </button>
          <div className="queue">
            {[...slaCockpit.breaches, ...slaCockpit.atRisk].map((entry) => (
              <article key={`sla-${entry.id}`} className={`patient-record-card ${selectedOrderId === entry.id ? "active" : ""}`}>
                <div className="patient-record-title">
                  {entry.id} | {entry.dispatchStatus || "none"} | {entry.sla?.breached ? "breached" : "at_risk"}
                </div>
                <div className="meta">
                  Open: {Number(entry.sla?.openMinutes || 0)}m | To breach: {Number(entry.sla?.minutesToBreach || 0)}m | ETA overdue:{" "}
                  {Number(entry.sla?.etaOverdueMinutes || 0)}m | Countdown: {formatSlaCountdown(entry)}
                </div>
                <div className="form-row">
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => {
                      setSelectedOrder(entry);
                      setCourierId(entry.courierId || "");
                      setOverrideCourierId(entry.courierId || "");
                      loadTimeline(entry.id);
                    }}
                  >
                    Select
                  </button>
                  <button className="primary" type="button" onClick={() => escalateOrder(entry.id)}>
                    Escalate now
                  </button>
                </div>
              </article>
            ))}
            {!slaCockpit.breaches.length && !slaCockpit.atRisk.length ? (
              <div className="meta">No active SLA risks.</div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className={`form dispatch-courier-left dispatch-courier-map${showOpsUI && !showCourierUI ? " dispatch-ops-card dispatch-ops-map" : ""}`}>
        <h3>Live Courier Map Feed</h3>
        <div className="dispatch-map-shell">
        <div className="meta">
          Geofence radius: {Number(liveMap.geofenceRadiusMeters || 0)}m | Updated:{" "}
          {liveMap.generatedAt ? new Date(liveMap.generatedAt).toLocaleString() : "n/a"}
        </div>
        <div className="dispatch-map-toolbar">
          <label className="dispatch-map-toggle">
            <input
              type="checkbox"
              checked={showDeviationOnly}
              onChange={(e) => setShowDeviationOnly(e.target.checked)}
            />
            Deviation-only
          </label>
          <button className="ghost" type="button" onClick={centerOnCourierMarker} disabled={!selectedOrderId && !showCourierUI}>
            Center on courier
          </button>
          <div className="dispatch-map-legend">
            <span><i className="legend-dot on-route" /> Courier on route</span>
            <span><i className="legend-dot deviation" /> Route deviation</span>
            <span><i className="legend-dot destination" /> Destination + geofence</span>
            <span><i className="legend-dot pulse-online" /> Pulse online</span>
            <span><i className="legend-dot pulse-offline" /> Pulse offline</span>
            <span style={{ marginLeft: 12, fontStyle: 'italic', fontSize: 12 }}>Distances shown = courier to pharmacy + courier to delivery</span>
          </div>
        </div>
        <div className="dispatch-map-canvas">
          <MapContainer center={[6.9271, 79.8612]} zoom={12} scrollWheelZoom className="dispatch-map-leaflet">
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <FitLiveMapBounds
              orders={liveMapOrders}
              selectedOrderId={selectedOrderId}
              centerOrderId={mapCenterOrderId}
              centerPoint={mapCenterPoint}
              centerSignal={mapCenterSignal}
            />
            {liveMapOrders.map((entry) => {
              const destination = toCoord(entry.destination);
              const pharmacyLoc = entry.pharmacyLocation ? toCoord(entry.pharmacyLocation) : null;
              const courier = toCoord(entry.courierPosition || entry.dispatchLastLocation);
              const trail = getTrail(entry);
              const isDeviation = Boolean(entry.routeDeviation);
              const trackingLive =
                Boolean(autoLocationEnabled)
                && showCourierUI
                && String(selectedOrderId || "") === String(entry.id || "");
              const entryCourierId = String(entry?.courierId || "").trim();
              const courierName =
                (opsCourierRoster.find((c) => String(c.courierId || "") === entryCourierId)?.courierName) ||
                String(entry?.courierName || entryCourierId || "Courier");
              const knownOnline = entryCourierId ? courierOnlineById.get(entryCourierId) : undefined;
              const isOwnCourier = showCourierUI && String(entryCourierId) === String(user?.id || "");
              const onlineState = typeof knownOnline === "boolean"
                ? knownOnline
                : isOwnCourier
                  ? courierAvailability.online !== false
                  : true;
              const isOfflineCourier = onlineState === false;
              const focusedCourier =
                String(selectedOrderId || "") === String(entry.id || "")
                || String(mapCenterOrderId || "") === String(entry.id || "");
              const ringColor = isDeviation ? "#d9480f" : "#2b8a3e";
              const trailColor = isDeviation ? "#e8590c" : "#1c7ed6";
              const pulseStrong = trackingLive || focusedCourier;
              const pulseRadius = pulseStrong
                ? 11 + ((pulseTick % 7) * 1.2)
                : 8 + ((pulseTick % 5) * 0.7);
              return (
                <Fragment key={`shape-${entry.id}`}>
                  {trail.length > 1 ? (
                    <Polyline positions={trail} pathOptions={{ color: trailColor, weight: 4, opacity: 0.8 }} />
                  ) : null}
                  {destination ? (
                    <>
                      <Circle
                        center={destination}
                        radius={Math.max(50, Number(liveMap.geofenceRadiusMeters || 250))}
                        pathOptions={{ color: ringColor, fillColor: ringColor, fillOpacity: 0.08, weight: 2 }}
                      />
                      <CircleMarker center={destination} radius={6} pathOptions={{ color: "#495057", fillColor: "#495057", fillOpacity: 1 }}>
                        <Popup>
                          {entry.id} destination
                          {entry.destinationAddress ? ` | ${entry.destinationAddress}` : ""}
                        </Popup>
                      </CircleMarker>
                    </>
                  ) : null}
                  {pharmacyLoc ? (
                    <>
                      <CircleMarker
                        center={pharmacyLoc}
                        radius={8}
                        pathOptions={{ color: "#6f42c1", fillColor: "#a78bfa", fillOpacity: 1 }}
                      >
                          <Tooltip direction="right" offset={[8, 0]} permanent>
                            {(() => {
                              const name = entry.pharmacyName || entry.pharmacyId || "Pharmacy";
                              const dist = entry.pharmacyDistanceMeters ? `${Number(entry.pharmacyDistanceMeters).toLocaleString()} m` : null;
                              const eta = entry.pharmacyEtaMinutes ? `${entry.pharmacyEtaMinutes} min` : null;
                              const parts = [name];
                              if (dist) parts.push(dist);
                              if (eta) parts.push(eta);
                              return parts.join(" \u2022 ");
                            })()}
                          </Tooltip>
                        <Popup>
                          Pharmacy: {entry.pharmacyName || entry.pharmacyId}
                          {entry.pharmacyLocation?.address ? ` | ${entry.pharmacyLocation.address}` : ""}
                          {entry.pharmacyDistanceMeters ? <div>Distance: {entry.pharmacyDistanceMeters} m</div> : null}
                          {entry.pharmacyEtaMinutes ? <div>ETA: {entry.pharmacyEtaMinutes} min</div> : null}
                          {entry.deliveryDistanceMeters || entry.deliveryDistanceMeters === 0 ? (
                            <div>Courier to delivery: {entry.deliveryDistanceMeters} m</div>
                          ) : null}
                          {entry.deliveryEtaMinutes || entry.deliveryEtaMinutes === 0 ? (
                            <div>Delivery ETA: {entry.deliveryEtaMinutes} min</div>
                          ) : null}
                        </Popup>
                      </CircleMarker>
                      {courier && (
                        <Polyline
                          positions={[courier, pharmacyLoc]}
                          pathOptions={{ color: "#6f42c1", dashArray: "6,8", weight: 2, opacity: 0.7 }}
                        />
                      )}
                    </>
                  ) : null}
                  {courier ? (
                    <>
                      <CircleMarker
                        center={courier}
                        radius={pulseRadius}
                        pathOptions={{
                          color: isOfflineCourier ? "#c92a2a" : "#2b8a3e",
                          fillColor: isOfflineCourier ? "#ff6b6b" : "#69db7c",
                          fillOpacity: pulseStrong ? 0.14 : 0.08,
                          opacity: pulseStrong ? 0.75 : 0.45,
                          weight: pulseStrong ? 2.2 : 1.4,
                        }}
                      />
                      <CircleMarker
                        center={courier}
                        radius={7}
                        pathOptions={{
                          color: isOfflineCourier ? "#a61e4d" : (isDeviation ? "#d6336c" : "#0b7285"),
                          fillColor: isOfflineCourier ? "#ff8787" : (isDeviation ? "#f06595" : "#15aabf"),
                          fillOpacity: 1,
                        }}
                      >
                        <Tooltip direction="top" offset={[0, -10]} permanent>
                          {(() => {
                            const parts = [courierName];
                            const toDistanceLabel = (rawDist) => {
                              if (!(rawDist || rawDist === 0)) return null;
                              const dist = Number(rawDist);
                              if (!Number.isFinite(dist)) return null;
                              if (dist >= 1000) return `${(dist / 1000).toFixed(1)} km`;
                              return `${dist.toLocaleString()} m`;
                            };
                            const pDist = toDistanceLabel(entry.pharmacyDistanceMeters);
                            const dDist = toDistanceLabel(entry.deliveryDistanceMeters);
                            if (pDist) parts.push(`P:${pDist}`);
                            if (dDist) parts.push(`D:${dDist}`);
                            if (entry.deliveryEtaMinutes || entry.deliveryEtaMinutes === 0) {
                              parts.push(`ETA:${entry.deliveryEtaMinutes} min`);
                            } else if (entry.pharmacyEtaMinutes || entry.pharmacyEtaMinutes === 0) {
                              parts.push(`ETA:${entry.pharmacyEtaMinutes} min`);
                            }
                            return parts.join(" \u2022 ");
                          })()}
                        </Tooltip>
                        <Popup>
                          {entry.id} | {entry.dispatchStatus || "none"} | {isDeviation ? "route deviation" : "on route"}
                          {` | ${isOfflineCourier ? "courier offline" : "courier online"}`}
                          {trackingLive ? " | tracking live" : ""}
                          {entry.pharmacyDistanceMeters || entry.pharmacyDistanceMeters === 0 ? (
                            <div>Courier to pharmacy: {entry.pharmacyDistanceMeters} m</div>
                          ) : null}
                          {entry.deliveryDistanceMeters || entry.deliveryDistanceMeters === 0 ? (
                            <div>Courier to delivery: {entry.deliveryDistanceMeters} m</div>
                          ) : null}
                          {entry.deliveryEtaMinutes || entry.deliveryEtaMinutes === 0 ? (
                            <div>Delivery ETA: {entry.deliveryEtaMinutes} min</div>
                          ) : null}
                        </Popup>
                      </CircleMarker>
                    </>
                  ) : null}
                </Fragment>
              );
            })}
            {mapCenterPoint && Number.isFinite(Number(mapCenterPoint.lat)) && Number.isFinite(Number(mapCenterPoint.lng)) ? (
              <Fragment key="center-fallback-pulse">
                <CircleMarker
                  center={[Number(mapCenterPoint.lat), Number(mapCenterPoint.lng)]}
                  radius={11 + ((pulseTick % 7) * 1.2)}
                  pathOptions={{
                    color: (mapCenterCourierId && courierOnlineById.get(String(mapCenterCourierId)) === false) ? "#c92a2a" : "#2b8a3e",
                    fillColor: (mapCenterCourierId && courierOnlineById.get(String(mapCenterCourierId)) === false) ? "#ff6b6b" : "#69db7c",
                    fillOpacity: 0.16,
                    opacity: 0.82,
                    weight: 2.2,
                  }}
                />
                <CircleMarker
                  center={[Number(mapCenterPoint.lat), Number(mapCenterPoint.lng)]}
                  radius={7}
                  pathOptions={{
                    color: (mapCenterCourierId && courierOnlineById.get(String(mapCenterCourierId)) === false) ? "#a61e4d" : "#0b7285",
                    fillColor: (mapCenterCourierId && courierOnlineById.get(String(mapCenterCourierId)) === false) ? "#ff8787" : "#15aabf",
                    fillOpacity: 1,
                  }}
                >
                  <Popup>
                    Latest courier ping{mapCenterCourierId ? ` | ${mapCenterCourierId}` : ""}
                  </Popup>
                </CircleMarker>
              </Fragment>
            ) : null}
          </MapContainer>
        </div>
        <div className="queue">
          {mapListOrders.map((entry) => (
            <button
              key={`map-${entry.id}`}
              type="button"
              className={`patient-record-card ${selectedOrderId === entry.id ? "active" : ""}`}
              onClick={() => {
                setSelectedOrder(entry);
                setCourierId(entry.courierId || "");
                setOverrideCourierId(entry.courierId || "");
                loadTimeline(entry.id);
              }}
            >
              <div className="patient-record-title">
                {entry.id} | {entry.dispatchStatus || "none"} | {entry.routeDeviation ? "route_deviation" : "on_route"}
              </div>
              <div className="meta">
                Courier pos:{" "}
                {entry.courierPosition
                  ? `${Number(entry.courierPosition.lat).toFixed(5)}, ${Number(entry.courierPosition.lng).toFixed(5)}`
                  : "n/a"}{" "}
                | Breadcrumbs: {Array.isArray(entry.breadcrumbs) ? entry.breadcrumbs.length : 0} | Last ping:{" "}
                {formatLocationAge(entry)}
              </div>
              <div className="meta">
                Destination: {entry.destinationAddress || "n/a"} | Instructions:{" "}
                {entry.deliveryInstructions || "none"}
              </div>
              <div className="meta">
                Courier to pharmacy:{" "}
                {entry.pharmacyDistanceMeters || entry.pharmacyDistanceMeters === 0
                  ? `${Number(entry.pharmacyDistanceMeters).toLocaleString()} m`
                  : "n/a"}{" "}
                | Courier to delivery:{" "}
                {entry.deliveryDistanceMeters || entry.deliveryDistanceMeters === 0
                  ? `${Number(entry.deliveryDistanceMeters).toLocaleString()} m`
                  : "n/a"}{" "}
                | Delivery ETA:{" "}
                {entry.deliveryEtaMinutes || entry.deliveryEtaMinutes === 0
                  ? `${entry.deliveryEtaMinutes} min`
                  : "n/a"}
              </div>
            </button>
          ))}
          {!mapListOrders.length ? <div className="meta">No active courier map feed in this filter.</div> : null}
        </div>
        </div>
      </div>

      {showOpsUI ? (
        <div className="form dispatch-section-card dispatch-courier-left dispatch-ops-card dispatch-ops-exceptions">
          <h3>Exception Inbox</h3>
          <div className="queue">
            {exceptions.map((entry) => (
              <button
                key={`exc-${entry.id}`}
                type="button"
                className={`patient-record-card ${selectedOrderId === entry.id ? "active" : ""}`}
                onClick={() => {
                  setSelectedOrder(entry);
                  setCourierId(entry.courierId || "");
                  setOverrideCourierId(entry.courierId || "");
                  loadTimeline(entry.id);
                }}
              >
                <div className="patient-record-title">
                  {entry.id} | {entry.dispatchStatus || "none"} | OTP fails: {Number(entry.otpFailures || 0)}
                </div>
                <div className="meta">
                  Reason: {entry.dispatchFailureReason || "n/a"} | Updated:{" "}
                  {entry.latestExceptionAt ? new Date(entry.latestExceptionAt).toLocaleString() : "n/a"}
                </div>
              </button>
            ))}
            {!exceptions.length ? <div className="meta">No active exceptions.</div> : null}
          </div>
          <div className="form-row">
            <label>
              Override action
              <select value={overrideAction} onChange={(e) => setOverrideAction(e.target.value)}>
                <option value="unlock_otp">unlock_otp</option>
                <option value="clear_failure">clear_failure</option>
                <option value="reassign">reassign</option>
              </select>
            </label>
            {overrideAction === "reassign" ? (
              <label>
                New courier ID
                <input
                  value={overrideCourierId}
                  onChange={(e) => setOverrideCourierId(e.target.value)}
                  placeholder="Courier user ID"
                />
              </label>
            ) : null}
          </div>
          <label>
            Override reason (required)
            <input
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="Provide detailed supervisor reason"
            />
          </label>
          <button className="ghost" type="button" onClick={runSupervisorOverride} disabled={!selectedOrderId}>
            Apply supervisor override
          </button>
        </div>
      ) : null}

      <div className={`form dispatch-section-card dispatch-courier-bottom dispatch-courier-feed${showOpsUI && !showCourierUI ? " dispatch-ops-card dispatch-ops-feed" : ""}`}>
        <h3>Notification Center</h3>
        <div className="meta">
          Latest events: {eventFeed.length} | Scope: {showOpsUI ? "dispatcher" : "courier"}
        </div>
        <div className="queue">
          {eventFeed.map((event) => (
            <article key={event.id} className="queue-card dispatch-notification-card">
              <div className="queue-title">
                {event.type || "event"} | {event.orderId || "order"}
              </div>
              <div className="queue-meta">
                {new Date(event.at || Date.now()).toLocaleString()} | Audience: {event.audience || "n/a"} | Channel:{" "}
                {event.channel || "n/a"} | Status: {event.status || "n/a"}
              </div>
              <div className="queue-meta">
                Patient: {event.patientName || "n/a"} | Courier: {event.courierName || "n/a"}
              </div>
              {event.destinationAddress ? (
                <div className="queue-meta">Destination: {event.destinationAddress}</div>
              ) : null}
            </article>
          ))}
          {!eventFeed.length ? <div className="meta">No notification events yet.</div> : null}
        </div>
      </div>

      <div className={`form dispatch-section-card dispatch-courier-bottom dispatch-courier-timeline${showOpsUI && !showCourierUI ? " dispatch-ops-card dispatch-ops-timeline" : ""}`}>
        <h3>Timeline</h3>
        <div className="queue">
          {timeline.map((event) => (
            <article key={event.id} className="queue-card dispatch-timeline-card">
              <div className="queue-title">{event.type}</div>
              <div className="queue-meta">
                {new Date(event.at || Date.now()).toLocaleString()} | Actor: {event.actorUserId || "system"}
              </div>
            </article>
          ))}
          {!timeline.length ? <div className="meta">No timeline events for selected order.</div> : null}
        </div>
      </div>
      {message ? <p className="notice">{message}</p> : null}
      {error ? <p className="notice error">{error}</p> : null}
      {/* Courier acknowledgment modal: must accept when courier logs in */}
      {showCourierUI && !courierAckAccepted ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="courierAckTitle">
            <div>
              <h2 id="courierAckTitle">Important: Responsible Medication Delivery</h2>
              <p>
                Delivering medications is a sensitive and important responsibility. As the courier you must
                take care to confirm the recipient identity, follow the delivery instructions precisely,
                protect patient privacy, and escalate any safety or verification issues immediately.
              </p>
              <p>
                By accepting below you acknowledge that you understand the seriousness of handling and
                delivering prescription medications and agree to follow the required checklist and
                verification procedures on every delivery.
              </p>
            </div>
            <div className="form-row">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  try {
                    // If courier declines, log them out to prevent further actions
                    if (typeof window !== "undefined") {
                      localStorage.removeItem(`courier_ack_${String(user?.id || "anon")}`);
                    }
                  } catch (_e) {}
                  if (typeof window !== "undefined") window.location.href = "/auth";
                }}
              >
                Decline and logout
              </button>
              <button type="button" className="primary" onClick={acceptCourierAcknowledgement}>
                I Accept and Understand
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

