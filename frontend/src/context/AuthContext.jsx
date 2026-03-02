import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../utils/api.js";

const AuthContext = createContext(null);

const STORAGE_KEY = "refillit_auth";

const loadStored = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { token: null, user: null };
  } catch (_error) {
    return { token: null, user: null };
  }
};

export function AuthProvider({ children }) {
  const [state, setState] = useState(loadStored);
  const [ndaState, setNdaState] = useState({
    loading: false,
    required: false,
    accepted: true,
    acceptedAt: null,
    acceptedName: null,
    version: null,
    hash: null,
    title: "",
    text: "",
    requireTypedName: true,
    companyName: "Refillit",
  });

  const apiBase = import.meta.env.VITE_API_BASE || "http://127.0.0.1:4000";

  const setAuth = (next) => {
    const value = {
      token: next?.token || null,
      user: next?.user || null,
    };
    setState(value);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  };

  const logout = () => setAuth({ token: null, user: null });

  useEffect(() => {
    const onUnauthorized = () => {
      setState({ token: null, user: null });
      setNdaState((current) => ({
        ...current,
        loading: false,
        required: false,
        accepted: true,
        acceptedAt: null,
        acceptedName: null,
        version: null,
        hash: null,
      }));
    };
    window.addEventListener("refillit:unauthorized", onUnauthorized);
    return () => window.removeEventListener("refillit:unauthorized", onUnauthorized);
  }, []);

  const refreshDemoNdaStatus = async () => {
    if (!state.token) {
      setNdaState((current) => ({
        ...current,
        loading: false,
        required: false,
        accepted: true,
        acceptedAt: null,
        acceptedName: null,
        version: null,
        hash: null,
      }));
      return;
    }
    setNdaState((current) => ({ ...current, loading: true }));
    try {
      const [currentAgreement, status] = await Promise.all([
        apiFetch({
          apiBase,
          token: state.token,
          path: "/api/demo-nda/current",
        }),
        apiFetch({
          apiBase,
          token: state.token,
          path: "/api/demo-nda/status",
        }),
      ]);
      setNdaState({
        loading: false,
        required: Boolean(status?.nda?.required),
        accepted: Boolean(status?.nda?.accepted),
        acceptedAt: status?.nda?.acceptedAt || null,
        acceptedName: status?.nda?.acceptedName || null,
        version: status?.nda?.version || null,
        hash: status?.nda?.hash || null,
        title: currentAgreement?.agreement?.title || "Confidentiality Agreement",
        text: currentAgreement?.agreement?.text || "",
        requireTypedName: currentAgreement?.agreement?.requireTypedName !== false,
        companyName: currentAgreement?.agreement?.companyName || "Refillit",
      });
    } catch (_err) {
      setNdaState((current) => ({ ...current, loading: false }));
    }
  };

  const acceptDemoNda = async ({ acceptedName, agreed }) => {
    const data = await apiFetch({
      apiBase,
      token: state.token,
      path: "/api/demo-nda/accept",
      method: "POST",
      body: {
        acceptedName,
        agreed,
      },
    });
    setNdaState((current) => ({
      ...current,
      required: Boolean(data?.nda?.required),
      accepted: Boolean(data?.nda?.accepted),
      acceptedAt: data?.nda?.acceptedAt || null,
      acceptedName: data?.nda?.acceptedName || acceptedName || null,
      version: data?.nda?.version || current.version,
      hash: data?.nda?.hash || current.hash,
    }));
    return data;
  };

  useEffect(() => {
    refreshDemoNdaStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.token]);

  const value = useMemo(
    () => ({
      token: state.token,
      user: state.user,
      role: state.user?.role || null,
      isAuthed: Boolean(state.token),
      setAuth,
      logout,
      apiBase,
      ndaLoading: ndaState.loading,
      ndaRequired: ndaState.required,
      ndaAccepted: ndaState.accepted,
      ndaAcceptedAt: ndaState.acceptedAt,
      ndaAcceptedName: ndaState.acceptedName,
      ndaVersion: ndaState.version,
      ndaHash: ndaState.hash,
      ndaTitle: ndaState.title,
      ndaText: ndaState.text,
      ndaRequireTypedName: ndaState.requireTypedName,
      ndaCompanyName: ndaState.companyName,
      refreshDemoNdaStatus,
      acceptDemoNda,
    }),
    [state, apiBase, ndaState]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
