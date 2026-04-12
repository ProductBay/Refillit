import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { apiFetch } from "../utils/api.js";
import GlobalFeedbackOverlay from "./GlobalFeedbackOverlay.jsx";

const links = [
  { to: "/", label: "Home" },
  { to: "/doctor", label: "Doctor", allow: ["doctor"] },
  { to: "/receptionist", label: "Reception", allow: ["receptionist"] },
  { to: "/patient", label: "Patient", allow: ["patient", "caregiver", "patient_proxy"] },
  { to: "/pharmacy", label: "Pharmacy", allow: ["pharmacy"] },
  { to: "/dispatch", label: "Dispatch", allow: ["pharmacy", "admin"] },
  { to: "/courier", label: "Courier", allow: ["courier"] },
  { to: "/nhf", label: "NHF", allow: ["patient", "nhf"] },
  { to: "/moh", label: "MOH", allow: ["moh", "admin"] },
  { to: "/admin", label: "Admin", allow: ["admin"] },
];

export default function Layout() {
  const { user, isAuthed, logout, apiBase, token } = useAuth();
  const role = String(user?.role || "").toLowerCase();
  const visibleLinks = links.filter((entry) => {
    if (!entry.allow) return true;
    return isAuthed && entry.allow.includes(role);
  });
  const [chatOpen, setChatOpen] = useState(false);
  const [chatThreads, setChatThreads] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState("");
  const [activeThreadId, setActiveThreadId] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatTargetId, setChatTargetId] = useState("");
  const [chatSeedUsers, setChatSeedUsers] = useState([]);

  const totalUnread = useMemo(
    () => chatThreads.reduce((sum, thread) => sum + Number(thread.unreadCount || 0), 0),
    [chatThreads]
  );
  const activeThread = chatThreads.find((thread) => thread.id === activeThreadId) || null;

  const loadChatThreads = async () => {
    if (!isAuthed) return;
    try {
      setChatLoading(true);
      setChatError("");
      const data = await apiFetch({ apiBase, token, path: "/api/chat/threads" });
      setChatThreads(data.threads || []);
      if (activeThreadId) {
        const stillExists = (data.threads || []).some((thread) => thread.id === activeThreadId);
        if (!stillExists) {
          setActiveThreadId("");
          setChatMessages([]);
        }
      }
    } catch (err) {
      setChatError(err.message);
    } finally {
      setChatLoading(false);
    }
  };

  const loadChatMessages = async (threadId) => {
    if (!threadId) return;
    try {
      setChatError("");
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/chat/threads/${threadId}/messages`,
      });
      setChatMessages(data.messages || []);
    } catch (err) {
      setChatError(err.message);
    }
  };

  const loadSeededUsers = async () => {
    if (!isAuthed) return;
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/chat/seeded-users" });
      setChatSeedUsers(data.users || []);
    } catch (_err) {
      setChatSeedUsers([]);
    }
  };

  const startThread = async () => {
    const target = chatTargetId.trim();
    if (!target) {
      setChatError("Enter a target user ID to start a thread.");
      return;
    }
    try {
      setChatError("");
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/chat/threads",
        method: "POST",
        body: { participants: [target] },
      });
      const thread = data.thread;
      setChatThreads((current) => {
        const next = current.filter((item) => item.id !== thread.id);
        return [thread, ...next];
      });
      setActiveThreadId(thread.id);
      setChatTargetId("");
      await loadChatMessages(thread.id);
    } catch (err) {
      setChatError(err.message);
    }
  };

  const sendMessage = async () => {
    const content = chatDraft.trim();
    if (!content || !activeThreadId) return;
    try {
      setChatError("");
      await apiFetch({
        apiBase,
        token,
        path: `/api/chat/threads/${activeThreadId}/messages`,
        method: "POST",
        body: { message: content },
      });
      setChatDraft("");
      await Promise.all([loadChatMessages(activeThreadId), loadChatThreads()]);
    } catch (err) {
      setChatError(err.message);
    }
  };

  useEffect(() => {
    if (!isAuthed) {
      setChatThreads([]);
      setActiveThreadId("");
      setChatMessages([]);
      setChatSeedUsers([]);
      return;
    }
    if (chatOpen) {
      loadChatThreads();
      loadSeededUsers();
    }
  }, [isAuthed, chatOpen]);

  useEffect(() => {
    if (chatOpen && activeThreadId) loadChatMessages(activeThreadId);
  }, [chatOpen, activeThreadId]);

  return (
    <div className="page shell">
      <nav className="nav">
        <div className="brand nav-brand">
          <img src="/logo.png" alt="Refillit" className="platform-logo" />
          <div className="country-badge" aria-label="St Kitts and Nevis demo">
            <img
              src="/st-kitts-nevis-flag.gif"
              alt="St Kitts and Nevis flag"
              className="country-badge__flag"
            />
            <div className="country-badge__copy">
              <span className="country-badge__eyebrow">Demo Region</span>
              <span className="country-badge__name">St Kitts &amp; Nevis</span>
            </div>
          </div>
        </div>
        <div className="nav-links">
          {visibleLinks.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
            >
              {label}
            </NavLink>
          ))}
        </div>
        <div className="nav-links">
          <NavLink className="nav-link" to="/auth">
            {isAuthed ? `${user.role}` : "Login"}
          </NavLink>
          {isAuthed ? (
            <button className="ghost" onClick={logout}>
              Logout
            </button>
          ) : null}
        </div>
      </nav>
      <main className="content">
        <Outlet />
      </main>
      {isAuthed ? (
        <div className={`platform-chat ${chatOpen ? "open" : ""}`}>
          <button
            className="platform-chat-toggle"
            type="button"
            onClick={() => setChatOpen((current) => !current)}
            aria-expanded={chatOpen}
          >
            <span className="platform-chat-toggle__icon">C</span>
            <span>Fill-Chat</span>
            {totalUnread > 0 ? <span className="platform-chat-badge">{totalUnread}</span> : null}
          </button>
          {chatOpen ? (
            <div className="platform-chat-drawer">
              <div className="platform-chat-header">
                <div>
                  <div className="platform-chat-title">Fill-Chat</div>
                  <div className="platform-chat-subtitle">Role-secured messaging center</div>
                </div>
                <button className="ghost" type="button" onClick={loadChatThreads} disabled={chatLoading}>
                  {chatLoading ? "Refreshing..." : "Refresh"}
                </button>
              </div>
              <div className="platform-chat-start">
                <label>
                  Start new thread (User ID)
                  <input
                    value={chatTargetId}
                    onChange={(event) => setChatTargetId(event.target.value)}
                    placeholder="Paste target user ID"
                    list="chat-seeded-users"
                  />
                  <datalist id="chat-seeded-users">
                    {chatSeedUsers.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.fullName || entry.email} ({entry.role})
                      </option>
                    ))}
                  </datalist>
                </label>
                <button className="primary" type="button" onClick={startThread}>
                  Start
                </button>
              </div>
              {chatSeedUsers.length ? (
                <div className="platform-chat-seedlist">
                  {chatSeedUsers.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className="platform-chat-seed"
                      onClick={() => setChatTargetId(entry.id)}
                      title={`${entry.fullName || entry.email} (${entry.role})`}
                    >
                      <span className="platform-chat-seed__role">{entry.role}</span>
                      <span className="platform-chat-seed__name">{entry.fullName || entry.email}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="platform-chat-body">
                <aside className="platform-chat-threads">
                  {chatThreads.map((thread) => (
                    <button
                      key={thread.id}
                      type="button"
                      className={`platform-chat-thread ${
                        activeThreadId === thread.id ? "active" : ""
                      }`}
                      onClick={() => setActiveThreadId(thread.id)}
                    >
                      <div className="platform-chat-thread-title">
                        {thread.counterpartName || thread.counterpartRole || "Thread"}
                      </div>
                      <div className="platform-chat-thread-meta">
                        {thread.lastMessagePreview || "No messages yet"}
                      </div>
                      {thread.unreadCount ? (
                        <span className="platform-chat-thread-badge">{thread.unreadCount}</span>
                      ) : null}
                    </button>
                  ))}
                  {!chatThreads.length ? (
                    <div className="meta">No chat threads yet.</div>
                  ) : null}
                </aside>
                <section className="platform-chat-panel">
                  <div className="chat-window platform-chat-window">
                    {chatMessages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`chat-bubble ${
                          msg.senderId === user?.id ? "chat-patient" : "chat-office"
                        }`}
                      >
                        {msg.message}
                      </div>
                    ))}
                    {!chatMessages.length ? (
                      <div className="meta">Select a thread to view messages.</div>
                    ) : null}
                  </div>
                  <div className="form-row chat-form platform-chat-form">
                    <input
                      value={chatDraft}
                      onChange={(event) => setChatDraft(event.target.value)}
                      placeholder="Type a message..."
                      disabled={!activeThreadId}
                    />
                    <button className="primary" type="button" onClick={sendMessage} disabled={!chatDraft.trim() || !activeThreadId}>
                      Send
                    </button>
                  </div>
                </section>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <GlobalFeedbackOverlay
        errorMessage={chatError}
        onClose={() => setChatError("")}
      />
      <footer className="platform-footer">
        <div className="platform-footer__section">
          <div className="platform-footer__brand">
            <img src="/logo.png" alt="Refillit" className="platform-logo" />
            <span style={{ marginLeft: 8 }}></span>
          </div>
          <div className="platform-footer__meta">
            © 2026 Refillit. All rights reserved.
          </div>
          <div className="platform-footer__meta">
            Founder, Lead Developer & Architect: Ashandie Powell
          </div>
          <div className="platform-footer__meta">
            Assistant Architect for St Kitts & Nevis: Mr Quasim Walker
          </div>
          <div className="platform-footer__meta">
            Developed in partnership with {" "}
            <a className="platform-footer__anchor" href="https://a-dash-technology.vercel.app/" target="_blank" rel="noreferrer">
              A'Dash Technologies
            </a>
            {" & "}
            <a className="platform-footer__anchor" href="https://ritesupplies.com/" target="_blank" rel="noreferrer">
              Rite-Supplies
            </a>
          </div>
          <div className="platform-footer__meta">
            Mayfield Blvd, Southfield PO Box, St Elizabeth, Jamaica
          </div>
          <div className="platform-footer__meta">
            <a className="platform-footer__anchor" href="mailto:administrator@refillit.me">
              administrator@refillit.me
            </a>
          </div>
        </div>
        <div className="platform-footer__section">
          <div className="platform-footer__links">
            <button type="button" className="platform-footer__link">Privacy Policy</button>
            <button type="button" className="platform-footer__link">Terms of Use</button>
            <button type="button" className="platform-footer__link">Acceptable Use</button>
          </div>
          <div className="platform-footer__disclaimer">
            Demo environment only. Do not copy, redistribute, or modify any part of this platform or its code without
            written permission. Unauthorized use or duplication is prohibited.
          </div>
        </div>
        <div className="platform-footer__section">
          <div className="platform-footer__badge-title">Download the app</div>
          <div className="platform-footer__badges">
            <button type="button" className="store-badge">
              <span className="store-badge__icon">▶</span>
              <span className="store-badge__text">
                <span>Get it on</span>
                <strong>Google Play</strong>
              </span>
            </button>
            <button type="button" className="store-badge">
              <span className="store-badge__icon"></span>
              <span className="store-badge__text">
                <span>Download on the</span>
                <strong>App Store</strong>
              </span>
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
