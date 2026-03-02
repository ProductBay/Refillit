import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import "./styles.css";
import { AuthProvider } from "./context/AuthContext.jsx";

const root = createRoot(document.getElementById("root"));
// Global error handlers to capture unhandled promise rejections and runtime errors.
// These will help surface the real error payload (and optionally suppress noisy
// extension-related messages) so debugging is easier.
if (typeof window !== "undefined") {
  window.__lastUnhandledError = null;
  window.addEventListener("unhandledrejection", (evt) => {
    try {
      const reason = evt.reason;
      let msg = "";
      try {
        msg = String((reason && (reason.message || reason || "")) || "");
      } catch (e) {
        msg = String(reason || "");
      }
      // Ignore common noisy extension / devtools messages
      const noisyPatterns = [
        "A listener indicated an asynchronous response by returning true",
        "Could not establish connection",
        "Receiving end does not exist",
        "Unchecked runtime.lastError",
        "Download the React DevTools",
      ];
      if (noisyPatterns.some((p) => msg.includes(p))) {
        // record but avoid noisy stacktrace spam
        console.debug("Ignored noisy runtime message:", msg);
        window.__lastUnhandledError = { type: "unhandledrejection", reason };
        return;
      }
      console.error("Unhandled promise rejection:", reason);
      window.__lastUnhandledError = { type: "unhandledrejection", reason };
    } catch (e) {
      // swallow
    }
  });

  window.addEventListener("error", (evt) => {
    try {
      const msg = String(evt?.message || (evt?.error && evt.error.message) || "");
      const noisyPatterns = [
        "Could not establish connection",
        "Receiving end does not exist",
        "Unchecked runtime.lastError",
      ];
      if (noisyPatterns.some((p) => msg.includes(p))) {
        console.debug("Ignored noisy runtime error:", msg);
        window.__lastUnhandledError = { type: "error", error: evt.error || evt.message || evt };
        return;
      }
      console.error("Runtime error:", evt.error || evt.message || evt);
      window.__lastUnhandledError = { type: "error", error: evt.error || evt.message || evt };
    } catch (e) {}
  });
}
root.render(
  <React.StrictMode>
    <AuthProvider>
      <BrowserRouter
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <App />
      </BrowserRouter>
    </AuthProvider>
  </React.StrictMode>
);
