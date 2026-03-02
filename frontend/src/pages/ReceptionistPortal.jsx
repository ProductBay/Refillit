import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { apiFetch } from "../utils/api.js";

const toDateKey = (value) => {
  if (!value) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    return value.toISOString().slice(0, 10);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const raw = String(value || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
  }
  return parsed.toISOString().slice(0, 10);
};

export default function ReceptionistPortal() {
  const { apiBase, token, user } = useAuth();
  const [receptionistProfile, setReceptionistProfile] = useState(null);
  const [grants, setGrants] = useState([]);
  const [selectedGrantId, setSelectedGrantId] = useState("");
  const [availability, setAvailability] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [createdAppointmentLog, setCreatedAppointmentLog] = useState([]);
  const [appointmentDate, setAppointmentDate] = useState(() => toDateKey(new Date()));
  const [scheduleForm, setScheduleForm] = useState({
    availabilityId: "",
    reason: "",
  });
  const [selectedDoctorId, setSelectedDoctorId] = useState("");
  const [selectedPatientId, setSelectedPatientId] = useState("");
  const [patientQuery, setPatientQuery] = useState("");
  const [patientOptions, setPatientOptions] = useState([]);
  const [isLoadingPatients, setIsLoadingPatients] = useState(false);
  const [newPatientForm, setNewPatientForm] = useState({
    doctorId: "",
    fullName: "",
    email: "",
    phone: "",
    dob: "",
    address: "",
    idNumber: "",
    trn: "",
    allergies: "",
  });
  const [arrivalNotes, setArrivalNotes] = useState({});
  const [handoffDrafts, setHandoffDrafts] = useState({});
  const [paymentDrafts, setPaymentDrafts] = useState({});
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchResults, setGlobalSearchResults] = useState([]);
  const [isSearchingGlobal, setIsSearchingGlobal] = useState(false);
  const [outstandingBalances, setOutstandingBalances] = useState({ totals: null, accounts: [] });
  const [isLoadingOutstandingBalances, setIsLoadingOutstandingBalances] = useState(false);
  const [installmentProposals, setInstallmentProposals] = useState([]);
  const [isLoadingInstallmentProposals, setIsLoadingInstallmentProposals] = useState(false);
  const [decidingInstallmentIds, setDecidingInstallmentIds] = useState({});
  const [reminderChannels, setReminderChannels] = useState({
    email: true,
    sms: false,
    whatsapp: false,
  });
  const [isSendingReminders, setIsSendingReminders] = useState(false);
  const [lastReminderDispatch, setLastReminderDispatch] = useState(null);
  const [eligibilityDrafts, setEligibilityDrafts] = useState({});
  const [eligibilityCheckingByAppointment, setEligibilityCheckingByAppointment] = useState({});
  const [cashierSummary, setCashierSummary] = useState(null);
  const [billingAlerts, setBillingAlerts] = useState([]);
  const [billingAlertUnreadCount, setBillingAlertUnreadCount] = useState(0);
  const [isBillingAlertDrawerOpen, setIsBillingAlertDrawerOpen] = useState(false);
  const [isLoadingBillingAlerts, setIsLoadingBillingAlerts] = useState(false);
  const [isRefreshingCashier, setIsRefreshingCashier] = useState(false);
  const [arrivalDetailsAppointment, setArrivalDetailsAppointment] = useState(null);
  const [pollPausedUntil, setPollPausedUntil] = useState(0);
  const [keyboardModeEnabled, setKeyboardModeEnabled] = useState(true);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const globalSearchInputRef = useRef(null);

  const selectedGrant = useMemo(
    () => grants.find((entry) => entry.id === selectedGrantId) || null,
    [grants, selectedGrantId]
  );
  const employedDoctors = useMemo(() => {
    const byDoctor = new Map();
    for (const grant of grants || []) {
      if (!grant?.doctorId) continue;
      if (!byDoctor.has(grant.doctorId)) {
        byDoctor.set(grant.doctorId, {
          id: grant.doctorId,
          name: grant.doctorName || "Doctor",
        });
      }
    }
    if (receptionistProfile?.createdByDoctorId) {
      const id = receptionistProfile.createdByDoctorId;
      if (!byDoctor.has(id)) {
        byDoctor.set(id, {
          id,
          name: receptionistProfile.assignedDoctorName || "Assigned Doctor",
        });
      }
    }
    return Array.from(byDoctor.values());
  }, [grants, receptionistProfile]);

  const formatMoney = (currency, value) =>
    `${currency || "JMD"} ${Number(value || 0).toFixed(2)}`;
  const onApiError = (err, fallback = "") => {
    if (err?.status === 429) {
      setPollPausedUntil(Date.now() + 60_000);
      setError("Too many requests. Auto-refresh paused for 60 seconds.");
      return;
    }
    setError(err?.message || fallback || "Request failed");
  };
  const activeReceptionist = useMemo(() => {
    const profile = receptionistProfile || {};
    const sessionUser = user || {};
    return {
      id: profile.id || sessionUser.id || null,
      fullName: profile.fullName || sessionUser.fullName || null,
      email: profile.email || sessionUser.email || null,
      platformStaffId: profile.platformStaffId || sessionUser.platformStaffId || null,
      createdByDoctorId: profile.createdByDoctorId || sessionUser.createdByDoctorId || null,
      assignedDoctorName: profile.assignedDoctorName || null,
    };
  }, [receptionistProfile, user]);

  const loadGrants = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/receptionist/access-grants",
      });
      setReceptionistProfile(data.receptionist || null);
      const nextGrants = data.grants || [];
      setGrants(nextGrants);
      if (!selectedGrantId && nextGrants.length) {
        setSelectedGrantId(nextGrants[0].id);
      } else if (selectedGrantId && !nextGrants.some((entry) => entry.id === selectedGrantId)) {
        setSelectedGrantId(nextGrants[0]?.id || "");
      }
      return nextGrants;
    } catch (err) {
      onApiError(err, "Failed to load assignments");
      return [];
    }
  };

  const loadAvailability = async ({ doctorId, patientId } = {}) => {
    if (!doctorId) {
      setAvailability([]);
      return;
    }
    try {
      const query = patientId ? `?patientId=${encodeURIComponent(patientId)}` : "";
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/appointments/doctors/${doctorId}/availability${query}`,
      });
      const next = data.availability || [];
      setAvailability(next);
      setScheduleForm((current) => {
        if (!current.availabilityId) return current;
        if (next.some((slot) => slot.id === current.availabilityId)) return current;
        return { ...current, availabilityId: "" };
      });
    } catch (err) {
      onApiError(err, "Failed to load availability");
    }
  };

  const loadDoctorPatients = async (doctorId, query = "") => {
    if (!doctorId) {
      setPatientOptions([]);
      return;
    }
    try {
      setIsLoadingPatients(true);
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/patients?doctorId=${encodeURIComponent(doctorId)}&query=${encodeURIComponent(
          query
        )}`,
      });
      const next = data.patients || [];
      setPatientOptions(next);
      const q = String(query || "").trim().toLowerCase();
      if (q) {
        const exact =
          next.find((entry) => String(entry.fullName || "").toLowerCase() === q)
          || next.find((entry) => String(entry.email || "").toLowerCase() === q)
          || next.find((entry) => String(entry.id || "").toLowerCase() === q);
        if (exact) {
          setSelectedPatientId(exact.id);
        } else if (!selectedPatientId && next.length === 1) {
          setSelectedPatientId(next[0].id);
        }
      }
      if (selectedPatientId && !next.some((entry) => entry.id === selectedPatientId)) {
        setSelectedPatientId("");
      }
    } catch (err) {
      onApiError(err, "Failed to load patients");
    } finally {
      setIsLoadingPatients(false);
    }
  };

  const loadAppointments = async (date = appointmentDate) => {
    try {
      const query = date ? `?date=${encodeURIComponent(date)}` : "";
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/appointments${query}`,
      });
      const next = data.appointments || [];
      setAppointments(next);
      setArrivalDetailsAppointment((current) => {
        if (!current) return current;
        return next.find((entry) => entry.id === current.id) || current;
      });
    } catch (err) {
      onApiError(err, "Failed to load appointments");
    }
  };

  const loadCreatedAppointmentLog = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/receptionist/appointments",
      });
      const all = data.appointments || [];
      const myId = String(activeReceptionist?.id || user?.id || "");
      const mine = all
        .filter((entry) => {
          if (entry.source !== "receptionist_booking") return false;
          if (!myId) return true;
          const createdBy = String(entry.bookingCreatedBy || "");
          return !createdBy || createdBy === myId;
        })
        .sort((a, b) => new Date(b.bookingCreatedAt || b.createdAt || b.startAt) - new Date(a.bookingCreatedAt || a.createdAt || a.startAt))
        .slice(0, 100);
      setCreatedAppointmentLog(mine);
    } catch (err) {
      onApiError(err, "Failed to load receptionist booking log");
    }
  };

  const loadCashierSummary = async (date = appointmentDate, { forceLive = false } = {}) => {
    try {
      const params = new URLSearchParams();
      if (date) params.set("date", date);
      if (forceLive) params.set("_ts", String(Date.now()));
      const query = params.toString() ? `?${params.toString()}` : "";
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/cashier-summary${query}`,
      });
      setCashierSummary(data.summary || null);
    } catch (err) {
      onApiError(err, "Failed to load cashier summary");
    }
  };

  const loadBillingAlerts = async (date = "") => {
    try {
      setIsLoadingBillingAlerts(true);
      const query = date ? `?date=${encodeURIComponent(date)}` : "";
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/billing-alerts${query}`,
      });
      setBillingAlerts(data.alerts || []);
      setBillingAlertUnreadCount(Number(data.unreadCount || 0));
    } catch (err) {
      onApiError(err, "Failed to load billing alerts");
    } finally {
      setIsLoadingBillingAlerts(false);
    }
  };

  const loadOutstandingBalances = async () => {
    try {
      setIsLoadingOutstandingBalances(true);
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/outstanding-balances?date=${encodeURIComponent(appointmentDate)}`,
      });
      setOutstandingBalances({
        totals: data?.totals || { patientCount: 0, openCount: 0, overdueCount: 0, balanceTotal: 0 },
        accounts: data?.accounts || [],
      });
    } catch (err) {
      onApiError(err, "Failed to load outstanding balances");
    } finally {
      setIsLoadingOutstandingBalances(false);
    }
  };

  const loadInstallmentProposals = async () => {
    try {
      setIsLoadingInstallmentProposals(true);
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/receptionist/installment-proposals",
      });
      setInstallmentProposals(data?.proposals || []);
    } catch (err) {
      onApiError(err, "Failed to load installment proposals");
    } finally {
      setIsLoadingInstallmentProposals(false);
    }
  };

  const decideInstallmentProposal = async (proposalId, decision) => {
    if (!proposalId) return;
    setDecidingInstallmentIds((current) => ({ ...current, [proposalId]: decision }));
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/installment-proposals/${proposalId}/decision`,
        method: "POST",
        body: { decision },
      });
      await loadInstallmentProposals();
      setStatus(`Installment proposal ${decision}.`);
      setError("");
    } catch (err) {
      onApiError(err, "Failed to update installment proposal");
    } finally {
      setDecidingInstallmentIds((current) => ({ ...current, [proposalId]: "" }));
    }
  };

  const runGlobalSearch = async () => {
    const query = String(globalSearchQuery || "").trim();
    if (!query) {
      setGlobalSearchResults([]);
      return;
    }
    try {
      setIsSearchingGlobal(true);
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/search?query=${encodeURIComponent(query)}`,
      });
      setGlobalSearchResults(data?.results || []);
    } catch (err) {
      onApiError(err, "Failed to run global search");
    } finally {
      setIsSearchingGlobal(false);
    }
  };

  const openGlobalSearchResult = async (result) => {
    if (!result?.appointmentId) return;
    const dateKey = toDateKey(result.startAt || new Date());
    setAppointmentDate(dateKey);
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/appointments?date=${encodeURIComponent(dateKey)}`,
      });
      const nextAppointments = data?.appointments || [];
      setAppointments(nextAppointments);
      const found = nextAppointments.find((entry) => entry.id === result.appointmentId);
      if (found) {
        setArrivalDetailsAppointment(found);
        setStatus(`Opened ${result.type || "appointment"} from global search.`);
      } else {
        setError("Appointment found in search, but not visible in current context.");
      }
    } catch (err) {
      onApiError(err, "Failed to open search result");
    }
  };

  const dispatchSmartReminders = async ({ includeTomorrowAppointments, includeOverdueBalances }) => {
    const channels = Object.entries(reminderChannels)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([channel]) => channel);
    if (!channels.length) {
      setError("Select at least one channel (email, SMS, WhatsApp).");
      return;
    }
    try {
      setIsSendingReminders(true);
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/receptionist/reminders/dispatch",
        method: "POST",
        body: {
          channels,
          includeTomorrowAppointments,
          includeOverdueBalances,
        },
      });
      setLastReminderDispatch(data || null);
      setStatus(
        `Reminders queued: ${Number(data?.queued?.total || 0)} (${Number(
          data?.queued?.tomorrowAppointments || 0
        )} tomorrow, ${Number(data?.queued?.overdueBalances || 0)} overdue).`
      );
    } catch (err) {
      onApiError(err, "Failed to dispatch reminders");
    } finally {
      setIsSendingReminders(false);
    }
  };

  const refreshCashierSummaryLive = async () => {
    try {
      setIsRefreshingCashier(true);
      await Promise.all([
        loadCashierSummary(appointmentDate, { forceLive: true }),
        loadAppointments(appointmentDate),
        loadBillingAlerts(appointmentDate),
        loadOutstandingBalances(),
        loadInstallmentProposals(),
      ]);
      setStatus("Cashier summary refreshed with live data.");
    } finally {
      setIsRefreshingCashier(false);
    }
  };

  const renderReceiptHtml = (receipt) => {
    const amount = Number(receipt.amount || 0).toFixed(2);
    const fee = Number(receipt.appointment?.feeAmount || 0).toFixed(2);
    const nhfDeduction = Number(receipt.appointment?.nhfDeductionAmount || 0).toFixed(2);
    const paid = Number(receipt.appointment?.paymentCollectedAmount || 0).toFixed(2);
    const balance = Number(receipt.appointment?.paymentBalanceAmount || 0).toFixed(2);
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Receipt ${receipt.receiptNumber}</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;padding:20px;color:#111}
.card{max-width:680px;margin:0 auto;border:1px solid #d8e4e1;border-radius:12px;padding:18px}
h1{font-size:20px;margin:0 0 8px}
h2{font-size:14px;margin:18px 0 6px;color:#2d5a52}
.row{display:flex;justify-content:space-between;gap:14px;padding:4px 0;border-bottom:1px dashed #e4ece9}
.k{font-weight:600}
.v{text-align:right}
.tot{font-size:18px;font-weight:700;border-top:2px solid #c8dbd6;margin-top:10px;padding-top:10px}
</style></head><body>
<div class="card">
<h1>Payment Receipt</h1>
<div class="row"><div class="k">Receipt #</div><div class="v">${receipt.receiptNumber}</div></div>
<div class="row"><div class="k">Collected at</div><div class="v">${new Date(receipt.collectedAt).toLocaleString()}</div></div>
<div class="row"><div class="k">Method</div><div class="v">${receipt.method || "n/a"}</div></div>
<div class="row"><div class="k">Reference</div><div class="v">${receipt.reference || "n/a"}</div></div>
<div class="row tot"><div class="k">Amount Collected</div><div class="v">${receipt.currency} ${amount}</div></div>
<h2>Appointment</h2>
<div class="row"><div class="k">Appointment ID</div><div class="v">${receipt.appointment?.id || "n/a"}</div></div>
<div class="row"><div class="k">Doctor ID</div><div class="v">${receipt.appointment?.doctorId || "n/a"}</div></div>
<div class="row"><div class="k">Patient ID</div><div class="v">${receipt.appointment?.patientId || "n/a"}</div></div>
<div class="row"><div class="k">Fee</div><div class="v">${receipt.currency} ${fee}</div></div>
<div class="row"><div class="k">NHF deduction</div><div class="v">${receipt.currency} ${nhfDeduction}</div></div>
<div class="row"><div class="k">Total Paid To Date</div><div class="v">${receipt.currency} ${paid}</div></div>
<div class="row"><div class="k">Balance</div><div class="v">${receipt.currency} ${balance}</div></div>
<h2>Staff</h2>
<div class="row"><div class="k">Receptionist</div><div class="v">${receipt.receptionist?.name || "n/a"}</div></div>
<div class="row"><div class="k">Receptionist ID</div><div class="v">${receipt.receptionist?.platformStaffId || receipt.receptionist?.id || "n/a"}</div></div>
<div class="row"><div class="k">Doctor</div><div class="v">${receipt.doctor?.name || "n/a"}</div></div>
<div class="row"><div class="k">Doctor ID</div><div class="v">${receipt.doctor?.id || "n/a"}</div></div>
</div></body></html>`;
  };

  const printReceipt = (receipt) => {
    if (!receipt) return;
    const html = renderReceiptHtml(receipt);

    const frame = document.createElement("iframe");
    frame.style.position = "fixed";
    frame.style.right = "0";
    frame.style.bottom = "0";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    frame.setAttribute("aria-hidden", "true");
    document.body.appendChild(frame);

    const doc = frame.contentWindow?.document;
    if (!doc || !frame.contentWindow) return;
    doc.open();
    doc.write(html);
    doc.close();

    frame.contentWindow.focus();
    frame.contentWindow.print();

    setTimeout(() => {
      document.body.removeChild(frame);
    }, 500);
  };

  const createBooking = async () => {
    if (!selectedDoctorId) {
      setError("Select a doctor first.");
      return;
    }
    if (!selectedPatientId) {
      setError("Select a patient to book appointment.");
      return;
    }
    if (!scheduleForm.availabilityId) {
      setError("Select an availability slot.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: "/api/receptionist/appointments/bookings",
        method: "POST",
        body: {
          doctorId: selectedDoctorId,
          patientId: selectedPatientId,
          availabilityId: scheduleForm.availabilityId,
          reason: scheduleForm.reason || null,
        },
      });
      setStatus("Appointment booked from receptionist portal.");
      setScheduleForm({ availabilityId: "", reason: "" });
      await loadAvailability({ doctorId: selectedDoctorId, patientId: selectedPatientId });
      await loadAppointments();
      await loadCreatedAppointmentLog();
      await loadBillingAlerts();
    } catch (err) {
      onApiError(err, "Failed to create booking");
    }
  };

  const createPatientFromReception = async () => {
    const fullName = String(newPatientForm.fullName || "").trim();
    const email = String(newPatientForm.email || "").trim();
    const doctorId = String(newPatientForm.doctorId || "").trim();
    if (!doctorId) {
      setError("Select the doctor context for this patient.");
      return;
    }
    if (!fullName || !email) {
      setError("Patient full name and email are required.");
      return;
    }
    try {
      const response = await apiFetch({
        apiBase,
        token,
        path: "/api/receptionist/patients",
        method: "POST",
        body: {
          ...newPatientForm,
          fullName,
          email,
        },
      });
      setSelectedDoctorId(doctorId);
      setSelectedPatientId(response?.patient?.id || "");
      await loadDoctorPatients(doctorId, "");
      await loadGrants();
      if (response?.accessGrant?.id) {
        setSelectedGrantId(response.accessGrant.id);
      }
      setNewPatientForm((current) => ({
        ...current,
        fullName: "",
        email: "",
        phone: "",
        dob: "",
        address: "",
        idNumber: "",
        trn: "",
        allergies: "",
      }));
      setStatus(
        `Patient registered and linked to ${response?.accessGrant?.doctorName || "doctor"} for immediate booking.`
      );
    } catch (err) {
      onApiError(err, "Failed to enroll patient");
    }
  };

  const setArrivalStatus = async (appointment, nextStatus) => {
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/appointments/${appointment.id}/arrival-status`,
        method: "POST",
        body: {
          status: nextStatus,
          note: arrivalNotes[appointment.id] || null,
        },
      });
      setArrivalDetailsAppointment((current) =>
        current && current.id === appointment.id ? { ...current, arrivalStatus: nextStatus } : current
      );
      setStatus(`Appointment moved to ${String(nextStatus).replace("_", " ")}.`);
      await loadAppointments();
    } catch (err) {
      onApiError(err, "Failed to update arrival status");
    }
  };

  const getPaymentDraft = (appointment) => {
    const existing = paymentDrafts[appointment.id];
    if (existing) return existing;
    return {
      amount: Number(appointment?.payment?.balanceAmount || appointment?.feeAmount || 0),
      method: "cash",
      nhfDeductionAmount: Number(appointment?.payment?.nhfDeductionAmount || appointment?.nhfDeductionAmount || 0),
      nhfReference: String(appointment?.payment?.nhfReference || appointment?.nhfReference || ""),
      reference: "",
      notes: "",
    };
  };

  const getHandoffDraft = (appointment) => {
    const existing = handoffDrafts[appointment.id];
    if (existing) return existing;
    const current = appointment?.structuredDoctorHandoff || {};
    return {
      reason: String(current.reason || ""),
      billing: String(current.billing || ""),
      specialHandling: String(current.specialHandling || ""),
      priority: String(current.priority || "normal"),
    };
  };

  const updateHandoffDraft = (appointmentId, patch) => {
    setHandoffDrafts((current) => {
      const prev = current[appointmentId] || {
        reason: "",
        billing: "",
        specialHandling: "",
        priority: "normal",
      };
      return {
        ...current,
        [appointmentId]: {
          ...prev,
          ...patch,
        },
      };
    });
  };

  const applyPaymentShortcut = (appointment, shortcut) => {
    const payment = appointment?.payment || {};
    const feeAmount = Number(payment.feeAmount ?? appointment?.feeAmount ?? 0);
    const paidAmount = Number(payment.paidAmount ?? appointment?.paymentCollectedAmount ?? 0);
    const balanceAmount = Math.max(0, Number(payment.balanceAmount ?? (feeAmount - paidAmount)));
    const existingNhf = Number(payment.nhfDeductionAmount ?? appointment?.nhfDeductionAmount ?? 0);
    if (shortcut === "full") {
      updatePaymentDraft(appointment.id, {
        amount: Number(balanceAmount.toFixed(2)),
        method: "cash",
      });
      return;
    }
    if (shortcut === "half") {
      updatePaymentDraft(appointment.id, {
        amount: Number((balanceAmount / 2).toFixed(2)),
        method: "cash",
      });
      return;
    }
    if (shortcut === "nhf_only") {
      const targetNhf = Math.min(feeAmount, Number((existingNhf + balanceAmount).toFixed(2)));
      updatePaymentDraft(appointment.id, {
        amount: 0,
        method: "insurance",
        nhfDeductionAmount: targetNhf,
      });
      return;
    }
    if (shortcut === "waive") {
      updatePaymentDraft(appointment.id, {
        amount: 0,
        method: "waived",
      });
    }
  };

  const getEligibilityDraft = (appointment) => {
    const existing = eligibilityDrafts[appointment.id];
    if (existing) return existing;
    const current = appointment?.insuranceEligibility || {};
    return {
      payerType: String(current.payerType || "nhf"),
      memberId: String(current.memberId || ""),
      planName: String(current.planName || ""),
      serviceDate: toDateKey(current.serviceDate || appointment?.startAt || new Date()) || toDateKey(new Date()),
      expectedAmount: Number(current.expectedAmount || appointment?.feeAmount || 0),
    };
  };

  const updateEligibilityDraft = (appointmentId, patch) => {
    setEligibilityDrafts((current) => {
      const prev = current[appointmentId] || {
        payerType: "nhf",
        memberId: "",
        planName: "",
        serviceDate: toDateKey(new Date()),
        expectedAmount: 0,
      };
      return {
        ...current,
        [appointmentId]: {
          ...prev,
          ...patch,
        },
      };
    });
  };

  const canCompleteWithoutEligibilityBlock = (appointment) => {
    const arrivalStatus = String(appointment?.arrivalStatus || "");
    if (!["arrived", "in_room"].includes(arrivalStatus)) return false;
    const eligibility = appointment?.insuranceEligibility || {};
    const payerType = String(eligibility.payerType || "").toLowerCase();
    if (!["nhf", "insurance"].includes(payerType)) return true;
    return String(eligibility.status || "").toLowerCase() === "eligible";
  };

  const closeArrivalDetailsModal = () => {
    setArrivalDetailsAppointment(null);
  };

  const updatePaymentDraft = (appointmentId, patch) => {
    setPaymentDrafts((current) => {
      const prev = current[appointmentId] || {
        amount: 0,
        method: "cash",
        nhfDeductionAmount: 0,
        nhfReference: "",
        reference: "",
        notes: "",
      };
      return {
        ...current,
        [appointmentId]: {
          ...prev,
          ...patch,
        },
      };
    });
  };

  const collectPayment = async (appointment) => {
    const draft = getPaymentDraft(appointment);
    try {
      const payload = {
        method: draft.method,
        amount: Number(draft.amount || 0),
        nhfDeductionAmount: Number(draft.nhfDeductionAmount || 0),
        nhfReference: draft.nhfReference || null,
        reference: draft.reference || null,
        notes: draft.notes || null,
      };
      const response = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/appointments/${appointment.id}/payment`,
        method: "POST",
        body: payload,
      });
      setStatus("Payment recorded for appointment.");
      if (response?.receipt) {
        printReceipt(response.receipt);
      }
      await loadAppointments(appointmentDate);
      await loadCashierSummary(appointmentDate);
      await loadBillingAlerts();
    } catch (err) {
      onApiError(err, "Failed to collect payment");
    }
  };

  const verifyInsuranceEligibility = async (appointment) => {
    if (!appointment?.id) return;
    const draft = getEligibilityDraft(appointment);
    try {
      setEligibilityCheckingByAppointment((current) => ({ ...current, [appointment.id]: true }));
      const response = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/appointments/${appointment.id}/insurance-eligibility-check`,
        method: "POST",
        body: {
          payerType: draft.payerType,
          memberId: draft.memberId,
          planName: draft.planName,
          serviceDate: draft.serviceDate,
          expectedAmount: Number(draft.expectedAmount || appointment?.feeAmount || 0),
        },
      });
      const nextAppointment = response?.appointment || null;
      if (nextAppointment) {
        setAppointments((current) =>
          current.map((entry) => (entry.id === nextAppointment.id ? { ...entry, ...nextAppointment } : entry))
        );
        setArrivalDetailsAppointment((current) =>
          current && current.id === nextAppointment.id ? { ...current, ...nextAppointment } : current
        );
      }
      const statusText = String(response?.eligibility?.status || "unchecked");
      setStatus(`Eligibility check completed: ${statusText}.`);
    } catch (err) {
      onApiError(err, "Failed to run eligibility check");
    } finally {
      setEligibilityCheckingByAppointment((current) => ({ ...current, [appointment.id]: false }));
    }
  };

  const saveDoctorHandoff = async (appointment) => {
    const draft = getHandoffDraft(appointment);
    try {
      const response = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/appointments/${appointment.id}/doctor-handoff`,
        method: "POST",
        body: {
          reason: draft.reason,
          billing: draft.billing,
          specialHandling: draft.specialHandling,
          priority: draft.priority,
        },
      });
      const nextAppointment = response?.appointment || null;
      if (nextAppointment) {
        setAppointments((current) =>
          current.map((entry) => (entry.id === nextAppointment.id ? { ...entry, ...nextAppointment } : entry))
        );
        setArrivalDetailsAppointment((current) =>
          current && current.id === nextAppointment.id ? { ...current, ...nextAppointment } : current
        );
      }
      setStatus("Structured handoff note sent to doctor inbox.");
    } catch (err) {
      onApiError(err, "Failed to save doctor handoff note");
    }
  };

  const markNoShow = async (appointment) => {
    try {
      const response = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/appointments/${appointment.id}/no-show`,
        method: "POST",
      });
      const nextAppointment = response?.appointment || null;
      if (nextAppointment) {
        setAppointments((current) =>
          current.map((entry) => (entry.id === nextAppointment.id ? { ...entry, ...nextAppointment } : entry))
        );
        setArrivalDetailsAppointment((current) =>
          current && current.id === nextAppointment.id ? { ...current, ...nextAppointment } : current
        );
      }
      const replacement = response?.replacement;
      if (replacement?.replaced) {
        setStatus("Marked no-show. Waitlist replacement auto-booked and doctor notified.");
      } else {
        setStatus("Marked no-show. Doctor notified.");
      }
      await loadAppointments(appointmentDate);
      await loadOutstandingBalances();
    } catch (err) {
      onApiError(err, "Failed to mark no-show");
    }
  };

  const markLateArrival = async (appointment) => {
    try {
      const response = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/appointments/${appointment.id}/late-arrival`,
        method: "POST",
        body: { note: arrivalNotes[appointment.id] || null },
      });
      const nextAppointment = response?.appointment || null;
      if (nextAppointment) {
        setAppointments((current) =>
          current.map((entry) => (entry.id === nextAppointment.id ? { ...entry, ...nextAppointment } : entry))
        );
        setArrivalDetailsAppointment((current) =>
          current && current.id === nextAppointment.id ? { ...current, ...nextAppointment } : current
        );
      }
      setStatus("Marked late-arrival and doctor notified.");
    } catch (err) {
      onApiError(err, "Failed to mark late-arrival");
    }
  };

  const markAsPaid = async (appointment) => {
    const balance = Number(appointment?.payment?.balanceAmount ?? 0);
    if (!Number.isFinite(balance) || balance <= 0) {
      setError("No outstanding balance to mark as paid.");
      return;
    }
    const draft = getPaymentDraft(appointment);
    try {
      const payload = {
        method: draft.method || "cash",
        amount: balance,
        nhfDeductionAmount: Number(draft.nhfDeductionAmount || 0),
        nhfReference: draft.nhfReference || null,
        reference: draft.reference || null,
        notes: draft.notes || null,
      };
      const response = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/appointments/${appointment.id}/payment`,
        method: "POST",
        body: payload,
      });
      setStatus("Payment marked as paid.");
      if (response?.receipt) {
        printReceipt(response.receipt);
      }
      await loadAppointments(appointmentDate);
      await loadCashierSummary(appointmentDate);
      await loadBillingAlerts();
    } catch (err) {
      onApiError(err, "Failed to mark payment");
    }
  };

  const printLatestReceipt = async (appointment) => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/receptionist/appointments/${appointment.id}/payment-receipt`,
      });
      if (data?.receipt) {
        printReceipt(data.receipt);
      } else {
        setError("No receipt available for this appointment.");
      }
    } catch (err) {
      onApiError(err, "Failed to load receipt");
    }
  };

  const boardColumns = useMemo(
    () => [
      { id: "waiting", title: "Waiting" },
      { id: "arrived", title: "Arrived" },
      { id: "in_room", title: "In Room" },
      { id: "completed", title: "Completed" },
    ],
    []
  );
  const appointmentsByStatus = useMemo(() => {
    const grouped = {
      waiting: [],
      arrived: [],
      in_room: [],
      completed: [],
    };
    for (const entry of appointments) {
      const key = grouped[entry.arrivalStatus] ? entry.arrivalStatus : "waiting";
      grouped[key].push(entry);
    }
    return grouped;
  }, [appointments]);
  const bookingSummary = useMemo(() => {
    const totalVisible = appointments.length;
    const bookedByMeVisible = appointments.filter((entry) => {
      if (entry.source !== "receptionist_booking") return false;
      const myId = String(activeReceptionist?.id || user?.id || "");
      if (!myId) return true;
      const createdBy = String(entry.bookingCreatedBy || "");
      return !createdBy || createdBy === myId;
    }).length;
    const pending = appointments.filter((entry) => entry.status === "pending").length;
    const approved = appointments.filter((entry) => entry.status === "approved").length;
    const completed = appointments.filter((entry) => entry.status === "completed").length;
    return { totalVisible, bookedByMeVisible, pending, approved, completed };
  }, [appointments, activeReceptionist, user]);

  useEffect(() => {
    loadGrants();
    loadAppointments(appointmentDate);
    loadCreatedAppointmentLog();
    loadCashierSummary(appointmentDate);
    loadBillingAlerts();
    loadOutstandingBalances();
    loadInstallmentProposals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (Date.now() < pollPausedUntil) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      loadAppointments(appointmentDate);
      loadBillingAlerts(appointmentDate);
      loadOutstandingBalances();
      loadInstallmentProposals();
      loadCreatedAppointmentLog();
    }, 30000);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentDate, pollPausedUntil]);

  useEffect(() => {
    if (selectedGrant) {
      setSelectedDoctorId(selectedGrant.doctorId || "");
      setSelectedPatientId(selectedGrant.patientId || "");
    } else {
      setSelectedDoctorId((current) => current || activeReceptionist?.createdByDoctorId || employedDoctors[0]?.id || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGrantId]);

  useEffect(() => {
    loadDoctorPatients(selectedDoctorId, patientQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDoctorId, patientQuery]);

  useEffect(() => {
    if (selectedDoctorId && !employedDoctors.some((entry) => entry.id === selectedDoctorId)) {
      setSelectedDoctorId(activeReceptionist?.createdByDoctorId || employedDoctors[0]?.id || "");
      setSelectedPatientId("");
      setAvailability([]);
      setScheduleForm((current) => ({ ...current, availabilityId: "" }));
      return;
    }
    if (selectedDoctorId) {
      loadAvailability({ doctorId: selectedDoctorId, patientId: selectedPatientId || "" });
    } else {
      setAvailability([]);
      setScheduleForm((current) => ({ ...current, availabilityId: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDoctorId, selectedPatientId, employedDoctors, activeReceptionist]);

  useEffect(() => {
    setNewPatientForm((current) => {
      if (current.doctorId) return current;
      const fallbackDoctorId =
        selectedGrant?.doctorId || activeReceptionist?.createdByDoctorId || employedDoctors[0]?.id || "";
      if (!fallbackDoctorId) return current;
      return { ...current, doctorId: fallbackDoctorId };
    });
  }, [selectedGrant, activeReceptionist, employedDoctors]);

  useEffect(() => {
    if (!keyboardModeEnabled) return undefined;
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return;
      const tag = String(event.target?.tagName || "").toLowerCase();
      const isTypingTarget = ["input", "textarea", "select"].includes(tag);
      if (event.key === "/" && !isTypingTarget) {
        event.preventDefault();
        globalSearchInputRef.current?.focus();
        return;
      }
      if (event.altKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        refreshCashierSummaryLive();
        return;
      }
      if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        const next = toDateKey(new Date(new Date(`${appointmentDate}T00:00:00`).getTime() + 24 * 60 * 60 * 1000));
        if (next) setAppointmentDate(next);
        return;
      }
      if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        const prev = toDateKey(new Date(new Date(`${appointmentDate}T00:00:00`).getTime() - 24 * 60 * 60 * 1000));
        if (prev) setAppointmentDate(prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardModeEnabled, appointmentDate]);

  return (
    <section className="panel doctor-shell">
      <button
        type="button"
        className="reception-alert-bell"
        onClick={() => setIsBillingAlertDrawerOpen(true)}
        aria-label="Open billing alerts"
      >
        <span className="reception-alert-bell__icon" aria-hidden>
          !
        </span>
        <span className="reception-alert-bell__text">Billing Alerts</span>
        {(billingAlertUnreadCount > 0 || billingAlerts.length > 0) && (
          <span className="reception-alert-bell__badge">
            {billingAlertUnreadCount > 99 ? "99+" : billingAlertUnreadCount || billingAlerts.length}
          </span>
        )}
      </button>
      {isBillingAlertDrawerOpen ? (
        <button
          type="button"
          className="reception-alert-overlay"
          aria-label="Close billing alerts"
          onClick={() => setIsBillingAlertDrawerOpen(false)}
        />
      ) : null}
      <aside className={`reception-alert-drawer${isBillingAlertDrawerOpen ? " open" : ""}`}>
        <div className="reception-alert-drawer__header">
          <h3>Billing Notifications</h3>
          <div className="form-row">
            <button className="ghost" type="button" onClick={() => loadBillingAlerts()}>
              {isLoadingBillingAlerts ? "Refreshing..." : "Refresh"}
            </button>
            <button
              className="ghost"
              type="button"
              onClick={() => setIsBillingAlertDrawerOpen(false)}
              aria-label="Close drawer"
            >
              Close
            </button>
          </div>
        </div>
        <p className="meta">
          New bills: <strong>{billingAlertUnreadCount}</strong> | Open bills:{" "}
          <strong>{billingAlerts.length}</strong>
        </p>
        <div className="reception-alert-drawer__list">
          {billingAlerts.map((alert) => {
            const appt = alert.appointment || {};
            const payment = appt.payment || {};
            const billing = appt.billing || {};
            const draft = getPaymentDraft(appt);
            const settled = ["paid", "waived"].includes(payment.status || appt.paymentStatus);
            const currency = payment.feeCurrency || appt.feeCurrency || "JMD";
            const targetDate = toDateKey(appt.startAt || new Date().toISOString());
            return (
              <article key={alert.id} className={`reception-alert-card${alert.isNew ? " is-new" : ""}`}>
                <div className="queue-title">
                  {alert.patient?.name || "Patient"} with {alert.doctor?.name || "Doctor"}
                </div>
                <div className="meta">
                  {new Date(appt.startAt || alert.createdAt || Date.now()).toLocaleString()} | Appointment:{" "}
                  {appt.id || "n/a"} | Doctor ID: {alert.doctor?.id || appt.doctorId || "n/a"} | Receptionist ID:{" "}
                  {activeReceptionist?.platformStaffId || "n/a"}
                </div>
                <div className="reception-billing-breakdown">
                  <div className="reception-billing-breakdown__row">
                    <span>Total fee</span>
                    <strong>{formatMoney(currency, payment.feeAmount || appt.feeAmount || 0)}</strong>
                  </div>
                  <div className="reception-billing-breakdown__row">
                    <span>NHF deduction</span>
                    <strong>{formatMoney(currency, payment.nhfDeductionAmount || appt.nhfDeductionAmount || 0)}</strong>
                  </div>
                  <div className="reception-billing-breakdown__row">
                    <span>Paid</span>
                    <strong>{formatMoney(currency, payment.paidAmount || appt.paymentCollectedAmount || 0)}</strong>
                  </div>
                  <div className="reception-billing-breakdown__row">
                    <span>Balance</span>
                    <strong>{formatMoney(currency, payment.balanceAmount || 0)}</strong>
                  </div>
                  <div className="reception-billing-breakdown__row">
                    <span>Payment status</span>
                    <strong>{payment.status || appt.paymentStatus || "unpaid"}</strong>
                  </div>
                </div>
                <details className="doctor-packet-panel">
                  <summary>Doctor packet</summary>
                  <div className="doctor-packet-panel__content">
                    <div className="meta">
                      Patient ID: {alert.patient?.id || appt.patientId || "n/a"} | Email:{" "}
                      {alert.patient?.email || "n/a"} | Phone: {alert.patient?.phone || "n/a"}
                    </div>
                    <div className="meta">
                      DOB: {alert.patient?.dob || "n/a"} | Address: {alert.patient?.address || "n/a"}
                    </div>
                    <div className="meta">
                      Consultation: {formatMoney(currency, billing.consultationFee ?? appt.consultationFee ?? 0)} |
                      Additional: {formatMoney(currency, billing.additionalCharges ?? appt.additionalCharges ?? 0)}
                    </div>
                    <div className="meta">
                      Ready at: {billing.billingReadyAt ? new Date(billing.billingReadyAt).toLocaleString() : "n/a"} |
                      Doctor charge notes: {billing.chargeNotes || appt.chargeNotes || "n/a"}
                    </div>
                    <div className="meta">
                      Handoff sent:{" "}
                      {billing.receptionHandoffAt
                        ? new Date(billing.receptionHandoffAt).toLocaleString()
                        : "n/a"}{" "}
                      | Handoff note: {billing.receptionHandoffNote || "n/a"} | Billing ready:{" "}
                      {billing.billingReadyForCollection ? "Yes" : "No"}
                    </div>
                  </div>
                </details>
                <div className="doctor-reminder-grid">
                  <div className="receptionist-payment-shortcuts">
                    <button className="ghost" type="button" onClick={() => applyPaymentShortcut(appt, "full")} disabled={settled}>
                      Full
                    </button>
                    <button className="ghost" type="button" onClick={() => applyPaymentShortcut(appt, "half")} disabled={settled}>
                      50%
                    </button>
                    <button className="ghost" type="button" onClick={() => applyPaymentShortcut(appt, "nhf_only")} disabled={settled}>
                      NHF only
                    </button>
                    <button className="ghost" type="button" onClick={() => applyPaymentShortcut(appt, "waive")} disabled={settled}>
                      Waive
                    </button>
                  </div>
                  <label>
                    Amount
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={draft.amount}
                      onChange={(e) =>
                        updatePaymentDraft(appt.id, {
                          amount: Number(e.target.value || 0),
                        })
                      }
                      disabled={settled}
                    />
                  </label>
                  <label>
                    Method
                    <select
                      value={draft.method}
                      onChange={(e) =>
                        updatePaymentDraft(appt.id, {
                          method: e.target.value,
                        })
                      }
                      disabled={settled}
                    >
                      <option value="cash">Cash</option>
                      <option value="card">Card</option>
                      <option value="transfer">Transfer</option>
                      <option value="insurance">Insurance</option>
                      <option value="other">Other</option>
                      <option value="waived">Waived</option>
                    </select>
                  </label>
                </div>
                <div className="doctor-reminder-grid">
                  <label>
                    NHF deduction
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={draft.nhfDeductionAmount}
                      onChange={(e) =>
                        updatePaymentDraft(appt.id, {
                          nhfDeductionAmount: Number(e.target.value || 0),
                        })
                      }
                      disabled={settled}
                    />
                  </label>
                  <label>
                    NHF reference
                    <input
                      value={draft.nhfReference}
                      onChange={(e) =>
                        updatePaymentDraft(appt.id, {
                          nhfReference: e.target.value,
                        })
                      }
                      placeholder="NHF claim/reference"
                      disabled={settled}
                    />
                  </label>
                </div>
                <div className="doctor-reminder-grid">
                  <label>
                    Payment reference
                    <input
                      value={draft.reference}
                      onChange={(e) =>
                        updatePaymentDraft(appt.id, {
                          reference: e.target.value,
                        })
                      }
                      placeholder="Card slip / cash receipt #"
                      disabled={settled}
                    />
                  </label>
                </div>
                <div className="form-row">
                  <button className="primary" type="button" onClick={() => collectPayment(appt)} disabled={settled}>
                    {settled ? "Payment settled" : "Collect now"}
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => markAsPaid(appt)}
                    disabled={settled || Number(payment.balanceAmount || 0) <= 0}
                  >
                    Mark as paid
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => {
                      setAppointmentDate(targetDate);
                      loadAppointments(targetDate);
                      loadCashierSummary(targetDate);
                      setIsBillingAlertDrawerOpen(false);
                    }}
                  >
                    Open on board
                  </button>
                </div>
              </article>
            );
          })}
          {!billingAlerts.length ? <div className="meta">No open billing alerts.</div> : null}
        </div>
      </aside>
      <h2>Receptionist Portal</h2>
      <p className="receptionist-page-intro">
        Front-desk workspace organized by context, patient intake, scheduling, billing, and daily operations.
      </p>
      <nav className="receptionist-section-nav" aria-label="Receptionist section shortcuts">
        <a href="#reception-context">Context</a>
        <a href="#reception-intake">Intake</a>
        <a href="#reception-billing-tools">Billing Tools</a>
        <a href="#reception-operations">Operations</a>
        <a href="#reception-logs">Logs</a>
      </nav>
      <div id="reception-context" className="doctor-summary receptionist-summary receptionist-summary--context">
        <article className="doctor-card doctor-card--wide receptionist-context-banner">
          <div className="doctor-card-header">
            <h3>Active Doctor Context</h3>
            <label className="receptionist-keyboard-toggle">
              <input
                type="checkbox"
                checked={keyboardModeEnabled}
                onChange={(e) => setKeyboardModeEnabled(Boolean(e.target.checked))}
              />
              Keyboard-first mode
            </label>
          </div>
          <div className="form-row">
            <label>
              Switch active doctor
              <select
                value={selectedDoctorId}
                onChange={(e) => {
                  setSelectedDoctorId(e.target.value);
                  setSelectedPatientId("");
                  setSelectedGrantId("");
                }}
              >
                <option value="">Select doctor</option>
                {employedDoctors.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} ({entry.id})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="meta">
            Active doctor: <strong>{employedDoctors.find((entry) => entry.id === selectedDoctorId)?.name || "None"}</strong>{" "}
            ({selectedDoctorId || "n/a"}) | Shortcuts: <code>/</code> focus search, <code>Alt+R</code> refresh,{" "}
            <code>Alt+Left/Right</code> date switch.
          </div>
        </article>
      </div>

      <div className="doctor-summary receptionist-summary receptionist-summary--search">
        <article className="doctor-card doctor-card--wide">
          <div className="doctor-card-header">
            <h3>Front-Desk Global Search</h3>
            <button className="ghost" type="button" onClick={runGlobalSearch} disabled={isSearchingGlobal}>
              {isSearchingGlobal ? "Searching..." : "Search"}
            </button>
          </div>
          <div className="form-row">
            <input
              ref={globalSearchInputRef}
              value={globalSearchQuery}
              onChange={(e) => setGlobalSearchQuery(e.target.value)}
              placeholder="Search name, phone, platform ID, appointment ID, receipt reference..."
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  runGlobalSearch();
                }
              }}
            />
          </div>
          {!globalSearchResults.length ? (
            <div className="meta">No results yet. Search across patients, appointments, and receipts.</div>
          ) : (
            <div className="queue-list">
              {globalSearchResults.map((result) => (
                <article key={result.id} className="queue-item">
                  <div className="queue-title">
                    [{result.type}] {result.label}
                  </div>
                  <div className="meta">{result.subtitle}</div>
                  <div className="form-row">
                    <button className="ghost" type="button" onClick={() => openGlobalSearchResult(result)}>
                      Open details
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </article>
      </div>

      <div id="reception-billing-tools" className="doctor-summary receptionist-summary receptionist-summary--billing-tools">
          <article className="doctor-card">
            <div className="doctor-card-header">
              <h3>Outstanding Balance Tracker</h3>
            <button className="ghost" type="button" onClick={loadOutstandingBalances}>
              {isLoadingOutstandingBalances ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          <div className="info-grid">
            <div>
              <div className="meta">Patients</div>
              <strong>{Number(outstandingBalances?.totals?.patientCount || 0)}</strong>
            </div>
            <div>
              <div className="meta">Open balances</div>
              <strong>{Number(outstandingBalances?.totals?.openCount || 0)}</strong>
            </div>
            <div>
              <div className="meta">Overdue</div>
              <strong>{Number(outstandingBalances?.totals?.overdueCount || 0)}</strong>
            </div>
            <div>
              <div className="meta">Total outstanding</div>
              <strong>JMD {Number(outstandingBalances?.totals?.balanceTotal || 0).toFixed(2)}</strong>
            </div>
          </div>
          {!outstandingBalances?.accounts?.length ? (
            <div className="meta">No outstanding balances in your current context.</div>
          ) : (
            <div className="queue-list">
              {outstandingBalances.accounts.slice(0, 12).map((account) => (
                <article key={account.patientId} className="queue-item">
                  <div className="queue-title">
                    {account.patientName} | JMD {Number(account.balanceTotal || 0).toFixed(2)}
                  </div>
                  <div className="meta">
                    Open: {account.openCount} | Overdue: {account.overdueCount} | Next due:{" "}
                    {account.nextDueDate ? toDateKey(account.nextDueDate) : "n/a"} | Phone:{" "}
                    {account.patientPhone || "n/a"}
                  </div>
                </article>
              ))}
            </div>
          )}
          </article>

          <article className="doctor-card">
            <div className="doctor-card-header">
              <h3>Installment Proposals</h3>
              <button className="ghost" type="button" onClick={loadInstallmentProposals}>
                {isLoadingInstallmentProposals ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            {!installmentProposals.length ? (
              <div className="meta">No installment proposals in your current doctor context.</div>
            ) : (
              <div className="queue-list">
                {installmentProposals.slice(0, 20).map((proposal) => (
                  <article key={proposal.id} className="queue-item">
                    <div className="queue-title">
                      {proposal.patientName || proposal.patientId || "Patient"} | {proposal.installments} x{" "}
                      {formatMoney(proposal.currency, proposal.amountEach)}
                    </div>
                    <div className="meta">
                      Total: {formatMoney(proposal.currency, proposal.totalAmount)} | Start:{" "}
                      {proposal.startDate || "n/a"} | Doctor: {proposal.doctorName || proposal.doctorId || "n/a"} | Status:{" "}
                      {proposal.status || "pending"}
                    </div>
                    {proposal.reviewedAt ? (
                      <div className="meta">
                        Reviewed: {new Date(proposal.reviewedAt).toLocaleString()} by{" "}
                        {proposal.reviewedByRole || "staff"}
                      </div>
                    ) : null}
                    {String(proposal.status || "").toLowerCase() === "pending" ? (
                      <div className="form-row">
                        <button
                          className="primary"
                          type="button"
                          disabled={Boolean(decidingInstallmentIds[proposal.id])}
                          onClick={() => decideInstallmentProposal(proposal.id, "approved")}
                        >
                          {decidingInstallmentIds[proposal.id] === "approved" ? "Approving..." : "Approve"}
                        </button>
                        <button
                          className="ghost"
                          type="button"
                          disabled={Boolean(decidingInstallmentIds[proposal.id])}
                          onClick={() => decideInstallmentProposal(proposal.id, "rejected")}
                        >
                          {decidingInstallmentIds[proposal.id] === "rejected" ? "Rejecting..." : "Reject"}
                        </button>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </article>

        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Smart Reminders</h3>
          </div>
          <div className="receptionist-reminder-channels">
            <label>
              <input
                type="checkbox"
                checked={reminderChannels.email}
                onChange={(e) =>
                  setReminderChannels((current) => ({ ...current, email: Boolean(e.target.checked) }))
                }
              />
              Email
            </label>
            <label>
              <input
                type="checkbox"
                checked={reminderChannels.sms}
                onChange={(e) =>
                  setReminderChannels((current) => ({ ...current, sms: Boolean(e.target.checked) }))
                }
              />
              SMS
            </label>
            <label>
              <input
                type="checkbox"
                checked={reminderChannels.whatsapp}
                onChange={(e) =>
                  setReminderChannels((current) => ({ ...current, whatsapp: Boolean(e.target.checked) }))
                }
              />
              WhatsApp
            </label>
          </div>
          <div className="form-row">
            <button
              className="ghost"
              type="button"
              disabled={isSendingReminders}
              onClick={() =>
                dispatchSmartReminders({ includeTomorrowAppointments: true, includeOverdueBalances: false })
              }
            >
              {isSendingReminders ? "Sending..." : "Send tomorrow reminders"}
            </button>
            <button
              className="primary"
              type="button"
              disabled={isSendingReminders}
              onClick={() =>
                dispatchSmartReminders({ includeTomorrowAppointments: false, includeOverdueBalances: true })
              }
            >
              {isSendingReminders ? "Sending..." : "Send overdue balance reminders"}
            </button>
          </div>
          {lastReminderDispatch ? (
            <div className="meta">
              Last dispatch: Total {Number(lastReminderDispatch?.queued?.total || 0)} | Tomorrow{" "}
              {Number(lastReminderDispatch?.queued?.tomorrowAppointments || 0)} | Overdue{" "}
              {Number(lastReminderDispatch?.queued?.overdueBalances || 0)} | Sent{" "}
              {Number(lastReminderDispatch?.delivery?.sent || 0)} | Failed{" "}
              {Number(lastReminderDispatch?.delivery?.failed || 0)} | Skipped{" "}
              {Number(lastReminderDispatch?.delivery?.skipped || 0)}
            </div>
          ) : (
            <div className="meta">Queue reminders by channel for tomorrow appointments and overdue balances.</div>
          )}
        </article>
      </div>

      <div id="reception-intake" className="doctor-summary receptionist-summary receptionist-summary--intake">
        <article className="doctor-card receptionist-identity-card">
          <div className="doctor-card-header">
            <h3>Receptionist Identity</h3>
          </div>
          <div className="receptionist-identity-grid">
            <div>
              <div className="meta">Full name</div>
              <strong>{activeReceptionist?.fullName || "n/a"}</strong>
            </div>
            <div>
              <div className="meta">Platform ID</div>
              <strong>{activeReceptionist?.platformStaffId || "n/a"}</strong>
            </div>
            <div>
              <div className="meta">Email</div>
              <strong>{activeReceptionist?.email || "n/a"}</strong>
            </div>
            <div>
              <div className="meta">Current doctor context</div>
              <strong>
                {selectedGrant
                  ? `${selectedGrant.doctorName || "Doctor"} (${selectedGrant.doctorId || "n/a"})`
                  : receptionistProfile?.createdByDoctorId
                    ? `${receptionistProfile.assignedDoctorName || "Assigned Doctor"} (${receptionistProfile.createdByDoctorId})`
                    : "n/a"}
              </strong>
            </div>
          </div>
          <div className="meta">Doctors employed to</div>
          <div className="receptionist-doctor-list">
            {employedDoctors.length ? (
              employedDoctors.map((doctor) => (
                <span key={doctor.id} className="doctor-pill">
                  {doctor.name} ({doctor.id})
                </span>
              ))
            ) : (
              <span className="meta">No assigned doctors yet.</span>
            )}
          </div>
        </article>

        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Authorized Patient Assignments</h3>
            <button className="ghost" type="button" onClick={loadGrants}>
              Refresh
            </button>
          </div>
          <label>
            Active assignment
            <select value={selectedGrantId} onChange={(e) => setSelectedGrantId(e.target.value)}>
              <option value="">Select assignment</option>
              {grants.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.doctorName} {"->"} {entry.patientName}
                </option>
              ))}
            </select>
          </label>
          {selectedGrant ? (
            <div className="meta">
              Scopes | Demographics: {selectedGrant.scopes?.canViewDemographics ? "Yes" : "No"} |
              Appointments: {selectedGrant.scopes?.canViewAppointments ? "Yes" : "No"} | Private
              Notes: {selectedGrant.scopes?.canViewPrivateNotes ? "Yes" : "No"} | Prescriptions:{" "}
              {selectedGrant.scopes?.canViewPrescriptions ? "Yes" : "No"}
            </div>
          ) : (
            <div className="meta">No assignment selected.</div>
          )}
        </article>

        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Register Patient</h3>
          </div>
          <label>
            Doctor context
            <select
              value={newPatientForm.doctorId}
              onChange={(e) =>
                setNewPatientForm((s) => ({ ...s, doctorId: e.target.value }))
              }
            >
              <option value="">Select doctor</option>
              {employedDoctors.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} ({entry.id})
                </option>
              ))}
            </select>
          </label>
          <div className="doctor-reminder-grid">
            <label>
              Full name
              <input
                value={newPatientForm.fullName}
                onChange={(e) => setNewPatientForm((s) => ({ ...s, fullName: e.target.value }))}
                placeholder="Patient full name"
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={newPatientForm.email}
                onChange={(e) => setNewPatientForm((s) => ({ ...s, email: e.target.value }))}
                placeholder="patient@email.com"
              />
            </label>
            <label>
              Phone
              <input
                value={newPatientForm.phone}
                onChange={(e) => setNewPatientForm((s) => ({ ...s, phone: e.target.value }))}
                placeholder="Phone"
              />
            </label>
            <label>
              DOB
              <input
                type="date"
                value={newPatientForm.dob}
                onChange={(e) => setNewPatientForm((s) => ({ ...s, dob: e.target.value }))}
              />
            </label>
            <label>
              ID number
              <input
                value={newPatientForm.idNumber}
                onChange={(e) => setNewPatientForm((s) => ({ ...s, idNumber: e.target.value }))}
                placeholder="Government ID"
              />
            </label>
            <label>
              TRN
              <input
                value={newPatientForm.trn}
                onChange={(e) => setNewPatientForm((s) => ({ ...s, trn: e.target.value }))}
                placeholder="TRN"
              />
            </label>
          </div>
          <label>
            Address
            <input
              value={newPatientForm.address}
              onChange={(e) => setNewPatientForm((s) => ({ ...s, address: e.target.value }))}
              placeholder="Address"
            />
          </label>
          <label>
            Allergies (comma-separated)
            <input
              value={newPatientForm.allergies}
              onChange={(e) => setNewPatientForm((s) => ({ ...s, allergies: e.target.value }))}
              placeholder="Penicillin, peanuts"
            />
          </label>
          <button className="primary" type="button" onClick={createPatientFromReception}>
            Enroll patient
          </button>
          <div className="meta">
            New patient is added to doctor records, receptionist grant is created, and the patient becomes selectable for
            appointment booking.
          </div>
        </article>

        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Schedule Appointment</h3>
          </div>
          <label>
            Doctor context
            <select value={selectedDoctorId} onChange={(e) => setSelectedDoctorId(e.target.value)}>
              <option value="">Select doctor</option>
              {employedDoctors.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} ({entry.id})
                </option>
              ))}
            </select>
          </label>
          <label>
            Search patient (walk-in or existing)
            <input
              list="reception-patient-suggestions"
              value={patientQuery}
              onChange={(e) => {
                const nextQuery = e.target.value;
                setPatientQuery(nextQuery);
                const lowered = String(nextQuery || "").trim().toLowerCase();
                const match =
                  patientOptions.find((entry) => String(entry.fullName || "").toLowerCase() === lowered)
                  || patientOptions.find((entry) => String(entry.email || "").toLowerCase() === lowered)
                  || patientOptions.find((entry) => String(entry.id || "").toLowerCase() === lowered);
                if (match) {
                  setSelectedPatientId(match.id);
                }
              }}
              placeholder="Name, email, or patient ID"
              disabled={!selectedDoctorId}
            />
            <datalist id="reception-patient-suggestions">
              {patientOptions.map((entry) => (
                <option key={entry.id} value={entry.fullName}>
                  {entry.email || entry.id}
                </option>
              ))}
            </datalist>
          </label>
          <label>
            Patient
            <select
              value={selectedPatientId}
              onChange={(e) => {
                const nextPatientId = e.target.value;
                setSelectedPatientId(nextPatientId);
                const chosen = patientOptions.find((entry) => entry.id === nextPatientId);
                if (chosen?.fullName) {
                  setPatientQuery(chosen.fullName);
                }
              }}
              disabled={!selectedDoctorId || isLoadingPatients}
            >
              <option value="">{isLoadingPatients ? "Loading patients..." : "Select patient"}</option>
              {patientOptions.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.fullName} ({entry.id.slice(0, 8)})
                </option>
              ))}
            </select>
          </label>
          <label>
            Available slot
            <select
              value={scheduleForm.availabilityId}
              onChange={(e) =>
                setScheduleForm((s) => ({ ...s, availabilityId: e.target.value }))
              }
              disabled={!selectedDoctorId}
            >
              <option value="">
                {!selectedDoctorId
                  ? "Select doctor first"
                  : availability.length
                    ? "Select slot"
                    : "No available slots"}
              </option>
              {availability.map((slot) => (
                <option key={slot.id} value={slot.id}>
                  {new Date(slot.startAt).toLocaleString()} ({slot.remaining} open){" "}
                  {slot.feeRequired
                    ? `| fee ${slot.feeCurrency || "JMD"} ${Number(slot.feeAmount || 0).toFixed(2)}`
                    : "| no fee"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reason
            <input
              value={scheduleForm.reason}
              onChange={(e) => setScheduleForm((s) => ({ ...s, reason: e.target.value }))}
              disabled={!selectedDoctorId || !selectedPatientId}
            />
          </label>
          <button
            className="primary"
            type="button"
            onClick={createBooking}
            disabled={!selectedDoctorId || !selectedPatientId}
          >
            Book appointment
          </button>
          <div className="meta">
            Front desk can book for existing walk-in patients or newly enrolled patients under selected doctor context.
          </div>
        </article>
      </div>

      <div id="reception-operations" className="doctor-summary receptionist-summary receptionist-summary--operations">
        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Booking Summary</h3>
            <button className="ghost" type="button" onClick={loadCreatedAppointmentLog}>
              Refresh log
            </button>
          </div>
          <div className="info-grid">
            <div>
              <div className="meta">Visible today</div>
              <strong>{bookingSummary.totalVisible}</strong>
            </div>
            <div>
              <div className="meta">Booked by me (visible)</div>
              <strong>{bookingSummary.bookedByMeVisible}</strong>
            </div>
            <div>
              <div className="meta">Pending</div>
              <strong>{bookingSummary.pending}</strong>
            </div>
            <div>
              <div className="meta">Approved</div>
              <strong>{bookingSummary.approved}</strong>
            </div>
            <div>
              <div className="meta">Completed</div>
              <strong>{bookingSummary.completed}</strong>
            </div>
            <div>
              <div className="meta">Log entries</div>
              <strong>{createdAppointmentLog.length}</strong>
            </div>
          </div>
        </article>

        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Cashier Summary (Daily)</h3>
            <button
              className="ghost"
              type="button"
              onClick={refreshCashierSummaryLive}
              disabled={isRefreshingCashier}
            >
              {isRefreshingCashier ? (
                <>
                  <span className="inline-spinner" aria-hidden="true" />
                  Refreshing...
                </>
              ) : (
                "Refresh"
              )}
            </button>
          </div>
          <div className="meta">
            Receptionist: {activeReceptionist?.fullName || "n/a"} | ID:{" "}
            {activeReceptionist?.platformStaffId || "n/a"} | Date: {cashierSummary?.date || appointmentDate}
          </div>
          <div className="info-grid">
            <div>
              <div className="meta">Cash</div>
              <strong>JMD {Number(cashierSummary?.cashTotal ?? 0).toFixed(2)}</strong>
            </div>
            <div>
              <div className="meta">Card</div>
              <strong>JMD {Number(cashierSummary?.cardTotal ?? 0).toFixed(2)}</strong>
            </div>
            <div>
              <div className="meta">Total</div>
              <strong>JMD {Number(cashierSummary?.totalCollected ?? 0).toFixed(2)}</strong>
            </div>
            <div>
              <div className="meta">Transactions</div>
              <strong>{cashierSummary?.transactionCount ?? 0}</strong>
            </div>
          </div>
        </article>

        <article className="doctor-card doctor-card--wide">
          <div className="doctor-card-header">
            <h3>Arrival Status Board</h3>
            <div className="form-row">
              <label>
                Date
                <input
                  type="date"
                  value={appointmentDate}
                  onChange={(e) => setAppointmentDate(e.target.value)}
                />
              </label>
              <button
                className="ghost"
                type="button"
                onClick={() => {
                  loadAppointments(appointmentDate);
                  loadCashierSummary(appointmentDate);
                  loadBillingAlerts(appointmentDate);
                }}
              >
                Load
              </button>
            </div>
          </div>
          <div className="reception-board">
            {boardColumns.map((column) => (
              <section key={column.id} className="reception-lane">
                <header className="reception-lane-header">
                  <h4>{column.title}</h4>
                  <span className="doctor-pill">{appointmentsByStatus[column.id]?.length || 0}</span>
                </header>
                <div className="reception-lane-list">
                  {(appointmentsByStatus[column.id] || []).map((entry) => (
                    <article key={entry.id} className="note-item reception-card">
                      <div className="queue-title">
                        {entry.patientName} with {entry.doctorName}
                      </div>
                      <div className="meta reception-card-meta">
                        {new Date(entry.startAt).toLocaleString()}
                      </div>
                      <div className="reception-card-inline-stats">
                        <span className={`doctor-pill doctor-pill--${entry.arrivalStatus || "waiting"}`}>
                          {entry.arrivalStatus || "waiting"}
                        </span>
                        <span className="meta">appt: {entry.status || "n/a"}</span>
                        <span className="meta">
                          fee: {formatMoney(entry.payment?.feeCurrency || entry.feeCurrency || "JMD", entry.payment?.feeAmount ?? entry.feeAmount ?? 0)}
                        </span>
                        <span className="meta">
                          bal: {formatMoney(entry.payment?.feeCurrency || entry.feeCurrency || "JMD", entry.payment?.balanceAmount ?? 0)}
                        </span>
                        <button
                          className="ghost reception-link-btn"
                          type="button"
                          onClick={() => setArrivalDetailsAppointment(entry)}
                        >
                          View details
                        </button>
                      </div>
                    </article>
                  ))}
                  {!appointmentsByStatus[column.id]?.length ? (
                    <div className="meta">No appointments.</div>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        </article>
      </div>

      <div id="reception-logs" className="doctor-summary receptionist-summary receptionist-summary--logs">
        <article className="doctor-card doctor-card--wide">
          <div className="doctor-card-header">
            <h3>Appointments Created By Receptionist</h3>
            <button className="ghost" type="button" onClick={loadCreatedAppointmentLog}>
              Refresh
            </button>
          </div>
          {!createdAppointmentLog.length ? (
            <div className="meta">No receptionist-created appointments yet.</div>
          ) : (
            <div className="queue-list">
              {createdAppointmentLog.map((entry) => (
                <article key={entry.id} className="queue-item">
                  <div className="queue-title">
                    {entry.patientName || "Patient"} with {entry.doctorName || "Doctor"}
                  </div>
                  <div className="meta">
                    Start: {entry.startAt ? new Date(entry.startAt).toLocaleString() : "n/a"} | Status:{" "}
                    {entry.status || "n/a"} | Arrival: {entry.arrivalStatus || "waiting"} | Appointment ID: {entry.id}
                  </div>
                  <div className="meta">
                    Created at:{" "}
                    {entry.bookingCreatedAt
                      ? new Date(entry.bookingCreatedAt).toLocaleString()
                      : entry.createdAt
                        ? new Date(entry.createdAt).toLocaleString()
                        : "n/a"}{" "}
                    | Source: {entry.source || "n/a"} | Fee:{" "}
                    {formatMoney(entry.feeCurrency || "JMD", entry.feeAmount || 0)}
                  </div>
                </article>
              ))}
            </div>
          )}
        </article>
      </div>

      {status ? <p className="notice">{status}</p> : null}
      {error ? <p className="notice error">{error}</p> : null}

      {arrivalDetailsAppointment ? (
        <div className="modal-backdrop" role="presentation" onClick={closeArrivalDetailsModal}>
          <div
            className="modal receptionist-arrival-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Appointment details"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>Appointment Details</h3>
              <button className="ghost" type="button" onClick={closeArrivalDetailsModal}>
                Close
              </button>
            </div>
            <div className="modal-body receptionist-arrival-modal-body">
              <section className="modal-section">
                <h4>Front Desk Actions</h4>
                <label>
                  Front desk note
                  <input
                    placeholder="Arrival / intake note"
                    value={arrivalNotes[arrivalDetailsAppointment.id] || ""}
                    onChange={(e) =>
                      setArrivalNotes((s) => ({ ...s, [arrivalDetailsAppointment.id]: e.target.value }))
                    }
                  />
                </label>
                <div className="form-row receptionist-arrival-actions">
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => setArrivalStatus(arrivalDetailsAppointment, "arrived")}
                    disabled={arrivalDetailsAppointment.arrivalStatus !== "waiting"}
                  >
                    Mark Arrived
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => setArrivalStatus(arrivalDetailsAppointment, "in_room")}
                    disabled={arrivalDetailsAppointment.arrivalStatus !== "arrived"}
                  >
                    Move to In Room
                  </button>
                  <button
                    className="primary"
                    type="button"
                    onClick={() => setArrivalStatus(arrivalDetailsAppointment, "completed")}
                    disabled={!canCompleteWithoutEligibilityBlock(arrivalDetailsAppointment)}
                  >
                    Mark Completed
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => markLateArrival(arrivalDetailsAppointment)}
                    disabled={["completed", "no_show"].includes(String(arrivalDetailsAppointment.status || "").toLowerCase())}
                  >
                    Mark Late Arrival
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => markNoShow(arrivalDetailsAppointment)}
                    disabled={!["pending", "approved"].includes(String(arrivalDetailsAppointment.status || "").toLowerCase())}
                  >
                    Mark No-show
                  </button>
                </div>
                {["nhf", "insurance"].includes(
                  String(arrivalDetailsAppointment?.insuranceEligibility?.payerType || "").toLowerCase()
                ) && !canCompleteWithoutEligibilityBlock(arrivalDetailsAppointment) ? (
                  <div className="meta notice-inline">
                    Completion is blocked until eligibility status is <strong>eligible</strong>.
                  </div>
                ) : null}
              </section>

              <section className="modal-section">
                <h4>Structured Doctor Handoff</h4>
                <div className="doctor-reminder-grid">
                  <label>
                    Clinical reason
                    <input
                      value={getHandoffDraft(arrivalDetailsAppointment).reason}
                      onChange={(e) =>
                        updateHandoffDraft(arrivalDetailsAppointment.id, { reason: e.target.value })
                      }
                      placeholder="Reason for handoff/update to doctor"
                    />
                  </label>
                  <label>
                    Billing note
                    <input
                      value={getHandoffDraft(arrivalDetailsAppointment).billing}
                      onChange={(e) =>
                        updateHandoffDraft(arrivalDetailsAppointment.id, { billing: e.target.value })
                      }
                      placeholder="Billing context for doctor"
                    />
                  </label>
                  <label>
                    Special handling
                    <input
                      value={getHandoffDraft(arrivalDetailsAppointment).specialHandling}
                      onChange={(e) =>
                        updateHandoffDraft(arrivalDetailsAppointment.id, { specialHandling: e.target.value })
                      }
                      placeholder="Mobility, language, urgent accommodations"
                    />
                  </label>
                  <label>
                    Priority
                    <select
                      value={getHandoffDraft(arrivalDetailsAppointment).priority}
                      onChange={(e) =>
                        updateHandoffDraft(arrivalDetailsAppointment.id, { priority: e.target.value })
                      }
                    >
                      <option value="normal">Normal</option>
                      <option value="urgent">Urgent</option>
                    </select>
                  </label>
                </div>
                <div className="form-row">
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => saveDoctorHandoff(arrivalDetailsAppointment)}
                  >
                    Send handoff to doctor
                  </button>
                </div>
                {arrivalDetailsAppointment?.structuredDoctorHandoff?.updatedAt ? (
                  <div className="meta">
                    Last sent: {new Date(arrivalDetailsAppointment.structuredDoctorHandoff.updatedAt).toLocaleString()} |
                    Priority: {arrivalDetailsAppointment.structuredDoctorHandoff.priority || "normal"}
                  </div>
                ) : (
                  <div className="meta">No structured handoff sent yet.</div>
                )}
              </section>

              <section className="modal-section">
                <h4>Insurance/NHF Verification</h4>
                <div className="doctor-reminder-grid">
                  <label>
                    Payer type
                    <select
                      value={getEligibilityDraft(arrivalDetailsAppointment).payerType}
                      onChange={(e) =>
                        updateEligibilityDraft(arrivalDetailsAppointment.id, { payerType: e.target.value })
                      }
                    >
                      <option value="nhf">NHF</option>
                      <option value="insurance">Insurance</option>
                      <option value="self_pay">Self-pay</option>
                    </select>
                  </label>
                  <label>
                    Member ID
                    <input
                      value={getEligibilityDraft(arrivalDetailsAppointment).memberId}
                      onChange={(e) =>
                        updateEligibilityDraft(arrivalDetailsAppointment.id, { memberId: e.target.value })
                      }
                      placeholder="NHF/insurance member number"
                    />
                  </label>
                  <label>
                    Plan name
                    <input
                      value={getEligibilityDraft(arrivalDetailsAppointment).planName}
                      onChange={(e) =>
                        updateEligibilityDraft(arrivalDetailsAppointment.id, { planName: e.target.value })
                      }
                      placeholder="Plan name (optional)"
                    />
                  </label>
                  <label>
                    Service date
                    <input
                      type="date"
                      value={getEligibilityDraft(arrivalDetailsAppointment).serviceDate}
                      onChange={(e) =>
                        updateEligibilityDraft(arrivalDetailsAppointment.id, { serviceDate: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Expected amount
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={getEligibilityDraft(arrivalDetailsAppointment).expectedAmount}
                      onChange={(e) =>
                        updateEligibilityDraft(arrivalDetailsAppointment.id, {
                          expectedAmount: Number(e.target.value || 0),
                        })
                      }
                    />
                  </label>
                </div>
                <div className="form-row">
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => verifyInsuranceEligibility(arrivalDetailsAppointment)}
                    disabled={Boolean(eligibilityCheckingByAppointment[arrivalDetailsAppointment.id])}
                  >
                    {eligibilityCheckingByAppointment[arrivalDetailsAppointment.id]
                      ? "Checking eligibility..."
                      : "Run eligibility check"}
                  </button>
                  <span
                    className={`doctor-pill eligibility-status-pill eligibility-status-pill--${String(
                      arrivalDetailsAppointment?.insuranceEligibility?.status || "unchecked"
                    ).toLowerCase()}`}
                  >
                    {String(arrivalDetailsAppointment?.insuranceEligibility?.status || "unchecked")}
                  </span>
                </div>
                <div className="meta">
                  {arrivalDetailsAppointment?.insuranceEligibility?.reason || "No eligibility check recorded yet."}
                </div>
                <div className="meta">
                  Approved:{" "}
                  {formatMoney(
                    arrivalDetailsAppointment?.payment?.feeCurrency || arrivalDetailsAppointment?.feeCurrency || "JMD",
                    arrivalDetailsAppointment?.insuranceEligibility?.approvedAmount || 0
                  )}{" "}
                  | Co-pay:{" "}
                  {formatMoney(
                    arrivalDetailsAppointment?.payment?.feeCurrency || arrivalDetailsAppointment?.feeCurrency || "JMD",
                    arrivalDetailsAppointment?.insuranceEligibility?.coPayAmount || 0
                  )}{" "}
                  | Ref: {arrivalDetailsAppointment?.insuranceEligibility?.reference || "n/a"}
                </div>
              </section>

              <section className="modal-section">
                <h4>Visit</h4>
                <div className="meta">
                  {arrivalDetailsAppointment.patientName || "Patient"} with{" "}
                  {arrivalDetailsAppointment.doctorName || "Doctor"}
                </div>
                <div className="meta">
                  Start:{" "}
                  {arrivalDetailsAppointment.startAt
                    ? new Date(arrivalDetailsAppointment.startAt).toLocaleString()
                    : "n/a"}
                </div>
                <div className="meta">
                  Arrival: {arrivalDetailsAppointment.arrivalStatus || "waiting"} | Appointment:{" "}
                  {arrivalDetailsAppointment.status || "n/a"}
                </div>
                <div className="meta">
                  Appointment ID: {arrivalDetailsAppointment.id || "n/a"} | Doctor ID:{" "}
                  {arrivalDetailsAppointment.doctorId || "n/a"} | Receptionist ID:{" "}
                  {activeReceptionist?.platformStaffId || "n/a"}
                </div>
              </section>

              <section className="modal-section">
                <h4>Billing</h4>
                <div className="reception-billing-breakdown">
                  <div className="reception-billing-breakdown__row">
                    <span>Total fee</span>
                    <strong>
                      {formatMoney(
                        arrivalDetailsAppointment.payment?.feeCurrency || arrivalDetailsAppointment.feeCurrency || "JMD",
                        arrivalDetailsAppointment.payment?.feeAmount ?? arrivalDetailsAppointment.feeAmount ?? 0
                      )}
                    </strong>
                  </div>
                  <div className="reception-billing-breakdown__row">
                    <span>Paid</span>
                    <strong>
                      {formatMoney(
                        arrivalDetailsAppointment.payment?.feeCurrency || arrivalDetailsAppointment.feeCurrency || "JMD",
                        arrivalDetailsAppointment.payment?.paidAmount
                          ?? arrivalDetailsAppointment.paymentCollectedAmount
                          ?? 0
                      )}
                    </strong>
                  </div>
                  <div className="reception-billing-breakdown__row">
                    <span>Balance</span>
                    <strong>
                      {formatMoney(
                        arrivalDetailsAppointment.payment?.feeCurrency || arrivalDetailsAppointment.feeCurrency || "JMD",
                        arrivalDetailsAppointment.payment?.balanceAmount ?? 0
                      )}
                    </strong>
                  </div>
                  <div className="reception-billing-breakdown__row">
                    <span>NHF deduction</span>
                    <strong>
                      {formatMoney(
                        arrivalDetailsAppointment.payment?.feeCurrency || arrivalDetailsAppointment.feeCurrency || "JMD",
                        arrivalDetailsAppointment.payment?.nhfDeductionAmount
                          ?? arrivalDetailsAppointment.nhfDeductionAmount
                          ?? 0
                      )}
                    </strong>
                  </div>
                  <div className="reception-billing-breakdown__row">
                    <span>Payment status</span>
                    <strong>
                      {arrivalDetailsAppointment.payment?.status
                        || arrivalDetailsAppointment.paymentStatus
                        || "not_required"}
                    </strong>
                  </div>
                </div>
                <div className="meta">
                  NHF ref:{" "}
                  {arrivalDetailsAppointment.payment?.nhfReference
                    || arrivalDetailsAppointment.nhfReference
                    || "n/a"}
                </div>
                {Boolean(arrivalDetailsAppointment.payment?.feeRequired ?? arrivalDetailsAppointment.feeRequired) ? (
                  <div className="doctor-reminder-panel">
                    <div className="receptionist-payment-shortcuts">
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => applyPaymentShortcut(arrivalDetailsAppointment, "full")}
                        disabled={["paid", "waived"].includes(
                          arrivalDetailsAppointment.payment?.status || arrivalDetailsAppointment.paymentStatus
                        )}
                      >
                        Full
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => applyPaymentShortcut(arrivalDetailsAppointment, "half")}
                        disabled={["paid", "waived"].includes(
                          arrivalDetailsAppointment.payment?.status || arrivalDetailsAppointment.paymentStatus
                        )}
                      >
                        50%
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => applyPaymentShortcut(arrivalDetailsAppointment, "nhf_only")}
                        disabled={["paid", "waived"].includes(
                          arrivalDetailsAppointment.payment?.status || arrivalDetailsAppointment.paymentStatus
                        )}
                      >
                        NHF only
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => applyPaymentShortcut(arrivalDetailsAppointment, "waive")}
                        disabled={["paid", "waived"].includes(
                          arrivalDetailsAppointment.payment?.status || arrivalDetailsAppointment.paymentStatus
                        )}
                      >
                        Waive
                      </button>
                    </div>
                    <div className="doctor-reminder-grid">
                      <label>
                        Amount
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={getPaymentDraft(arrivalDetailsAppointment).amount}
                          onChange={(e) =>
                            updatePaymentDraft(arrivalDetailsAppointment.id, {
                              amount: Number(e.target.value || 0),
                            })
                          }
                          disabled={["paid", "waived"].includes(
                            arrivalDetailsAppointment.payment?.status || arrivalDetailsAppointment.paymentStatus
                          )}
                        />
                      </label>
                      <label>
                        Method
                        <select
                          value={getPaymentDraft(arrivalDetailsAppointment).method}
                          onChange={(e) =>
                            updatePaymentDraft(arrivalDetailsAppointment.id, {
                              method: e.target.value,
                            })
                          }
                          disabled={["paid", "waived"].includes(
                            arrivalDetailsAppointment.payment?.status || arrivalDetailsAppointment.paymentStatus
                          )}
                        >
                          <option value="cash">Cash</option>
                          <option value="card">Card</option>
                          <option value="transfer">Transfer</option>
                          <option value="insurance">Insurance</option>
                          <option value="other">Other</option>
                          <option value="waived">Waived</option>
                        </select>
                      </label>
                      <label>
                        NHF deduction
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={getPaymentDraft(arrivalDetailsAppointment).nhfDeductionAmount}
                          onChange={(e) =>
                            updatePaymentDraft(arrivalDetailsAppointment.id, {
                              nhfDeductionAmount: Number(e.target.value || 0),
                            })
                          }
                          disabled={["paid", "waived"].includes(
                            arrivalDetailsAppointment.payment?.status || arrivalDetailsAppointment.paymentStatus
                          )}
                        />
                      </label>
                      <label>
                        NHF ref
                        <input
                          value={getPaymentDraft(arrivalDetailsAppointment).nhfReference}
                          onChange={(e) =>
                            updatePaymentDraft(arrivalDetailsAppointment.id, {
                              nhfReference: e.target.value,
                            })
                          }
                          placeholder="NHF claim/reference"
                          disabled={["paid", "waived"].includes(
                            arrivalDetailsAppointment.payment?.status || arrivalDetailsAppointment.paymentStatus
                          )}
                        />
                      </label>
                      <label>
                        Ref
                        <input
                          value={getPaymentDraft(arrivalDetailsAppointment).reference}
                          onChange={(e) =>
                            updatePaymentDraft(arrivalDetailsAppointment.id, {
                              reference: e.target.value,
                            })
                          }
                          placeholder="Receipt #"
                          disabled={["paid", "waived"].includes(
                            arrivalDetailsAppointment.payment?.status || arrivalDetailsAppointment.paymentStatus
                          )}
                        />
                      </label>
                    </div>
                    <div className="form-row">
                      <button
                        className="primary"
                        type="button"
                        onClick={() => collectPayment(arrivalDetailsAppointment)}
                        disabled={["paid", "waived"].includes(
                          arrivalDetailsAppointment.payment?.status || arrivalDetailsAppointment.paymentStatus
                        )}
                      >
                        {["paid", "waived"].includes(
                          arrivalDetailsAppointment.payment?.status || arrivalDetailsAppointment.paymentStatus
                        )
                          ? "Payment settled"
                          : "Collect payment"}
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => markAsPaid(arrivalDetailsAppointment)}
                        disabled={
                          ["paid", "waived"].includes(
                            arrivalDetailsAppointment.payment?.status || arrivalDetailsAppointment.paymentStatus
                          )
                          || Number(arrivalDetailsAppointment.payment?.balanceAmount ?? 0) <= 0
                        }
                      >
                        Mark as paid
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => printLatestReceipt(arrivalDetailsAppointment)}
                        disabled={
                          !Array.isArray(arrivalDetailsAppointment.payment?.history)
                          || !arrivalDetailsAppointment.payment.history.length
                        }
                      >
                        Print receipt
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="meta">No doctor fee configured for this appointment.</div>
                )}
              </section>

              <section className="modal-section">
                <h4>Doctor Packet</h4>
                <div className="meta">
                  Patient ID: {arrivalDetailsAppointment.patientId || "n/a"} | Email:{" "}
                  {arrivalDetailsAppointment.patientEmail || "n/a"} | Phone:{" "}
                  {arrivalDetailsAppointment.patientPhone || "n/a"}
                </div>
                <div className="meta">
                  DOB: {arrivalDetailsAppointment.patientDob || "n/a"} | Address:{" "}
                  {arrivalDetailsAppointment.patientAddress || "n/a"}
                </div>
                <div className="meta">
                  Consultation:{" "}
                  {formatMoney(
                    arrivalDetailsAppointment.billing?.feeCurrency || arrivalDetailsAppointment.feeCurrency || "JMD",
                    arrivalDetailsAppointment.billing?.consultationFee
                      ?? arrivalDetailsAppointment.consultationFee
                      ?? 0
                  )}{" "}
                  | Additional:{" "}
                  {formatMoney(
                    arrivalDetailsAppointment.billing?.feeCurrency || arrivalDetailsAppointment.feeCurrency || "JMD",
                    arrivalDetailsAppointment.billing?.additionalCharges
                      ?? arrivalDetailsAppointment.additionalCharges
                      ?? 0
                  )}
                </div>
                <div className="meta">
                  Ready:{" "}
                  {arrivalDetailsAppointment.billing?.billingReadyAt
                    ? new Date(arrivalDetailsAppointment.billing.billingReadyAt).toLocaleString()
                    : "not yet"}{" "}
                  | Doctor charge notes:{" "}
                  {arrivalDetailsAppointment.billing?.chargeNotes
                    || arrivalDetailsAppointment.chargeNotes
                    || "n/a"}
                </div>
                <div className="meta">
                  Handoff sent:{" "}
                  {arrivalDetailsAppointment.billing?.receptionHandoffAt
                    ? new Date(arrivalDetailsAppointment.billing.receptionHandoffAt).toLocaleString()
                    : "n/a"}{" "}
                  | Handoff note: {arrivalDetailsAppointment.billing?.receptionHandoffNote || "n/a"} | Billing
                  ready: {arrivalDetailsAppointment.billing?.billingReadyForCollection ? "Yes" : "No"}
                </div>
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
