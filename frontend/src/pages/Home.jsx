import { Link } from "react-router-dom";
import { useState } from "react";

const trustSignals = [
  {
    title: "Integrity-first prescribing",
    body: "Signed workflows, audit visibility, and role-aware controls keep clinical actions accountable.",
  },
  {
    title: "Security guaranteed by design",
    body: "Protected role gates, controlled handoffs, and traceable events reinforce platform trust end to end.",
  },
  {
    title: "One connected care network",
    body: "Doctors, patients, pharmacies, dispatch, NHF, MOH, and admin teams move in one operational rhythm.",
  },
];

const flowSteps = [
  "Doctor authors and confirms the prescription",
  "Patient submits the refill or treatment request",
  "Pharmacy verifies, prepares, and updates fulfillment",
  "Courier, NHF, and operations teams complete the secure handoff",
];

const assurancePills = ["Encrypted sessions", "Role-secured access", "Audit-ready workflow", "Dispatch visibility"];

export default function Home() {
  const [heroTilt, setHeroTilt] = useState({ rotateX: -8, rotateY: 12, glowX: 50, glowY: 42 });

  function handleHeroMove(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;

    setHeroTilt({
      rotateX: Number(((0.5 - y) * 18).toFixed(2)),
      rotateY: Number(((x - 0.5) * 20).toFixed(2)),
      glowX: Number((x * 100).toFixed(2)),
      glowY: Number((y * 100).toFixed(2)),
    });
  }

  function handleHeroLeave() {
    setHeroTilt({ rotateX: -8, rotateY: 12, glowX: 50, glowY: 42 });
  }

  return (
    <div className="splash-stack">
      <section className="hero splash-hero">
        <div className="splash-hero__copy">
          <div className="tagline splash-hero__tagline">Trusted Digital Rx Infrastructure</div>
          <h1>Refillit moves prescriptions with integrity, clarity, and platform-grade security.</h1>
          <p className="subhead splash-hero__subhead">
            A unified prescription network for clinical teams, pharmacies, patients, courier operations, NHF,
            and regulators. Built to feel calm at the surface and rigorous underneath.
          </p>
          <div className="splash-hero__actions">
            <Link className="primary splash-link-button" to="/auth">
              Enter platform
            </Link>
            <a className="ghost splash-link-button" href="#platform-assurance">
              Explore trust architecture
            </a>
          </div>
          <div className="splash-hero__pills" aria-label="Platform assurance highlights">
            {assurancePills.map((item) => (
              <span key={item} className="splash-pill">
                {item}
              </span>
            ))}
          </div>
        </div>

        <div
          className="splash-hero__visual"
          aria-hidden="true"
          onMouseMove={handleHeroMove}
          onMouseLeave={handleHeroLeave}
          style={{
            "--hero-rotate-x": `${heroTilt.rotateX}deg`,
            "--hero-rotate-y": `${heroTilt.rotateY}deg`,
            "--hero-glow-x": `${heroTilt.glowX}%`,
            "--hero-glow-y": `${heroTilt.glowY}%`,
          }}
        >
          <div className="splash-orbit">
            <span className="splash-orbit__plane splash-orbit__plane--back" />
            <span className="splash-orbit__ring splash-orbit__ring--outer" />
            <span className="splash-orbit__ring splash-orbit__ring--mid" />
            <span className="splash-orbit__ring splash-orbit__ring--inner" />
            <div className="splash-orbit__core">
              <img src="/logo.png" alt="" className="splash-orbit__logo" />
            </div>
            <span className="splash-orbit__plane splash-orbit__plane--front" />
            <div className="splash-orbit__badge splash-orbit__badge--security">Security</div>
            <div className="splash-orbit__badge splash-orbit__badge--integrity">Integrity</div>
            <div className="splash-orbit__badge splash-orbit__badge--coordination">Coordination</div>
          </div>
        </div>
      </section>

      <section id="platform-assurance" className="splash-trust-grid">
        {trustSignals.map((item, index) => (
          <article key={item.title} className="card splash-trust-card">
            <div className="splash-trust-card__index">0{index + 1}</div>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </article>
        ))}
      </section>

      <section className="splash-storyboard">
        <article className="card splash-storyboard__panel splash-storyboard__panel--flow">
          <div className="tagline splash-storyboard__eyebrow">Operational Flow</div>
          <h3>Every prescription passes through a visible, disciplined care chain.</h3>
          <div className="splash-flow">
            {flowSteps.map((step, index) => (
              <div key={step} className="splash-flow__item">
                <div className="splash-flow__number">{index + 1}</div>
                <p>{step}</p>
              </div>
            ))}
          </div>
        </article>

        <article className="card splash-storyboard__panel splash-storyboard__panel--command">
          <div className="tagline splash-storyboard__eyebrow">Platform Posture</div>
          <h3>Professional enough for operations. Clear enough for every role.</h3>
          <div className="splash-command">
            <div className="splash-command__metric">
              <span className="splash-command__value">8</span>
              <span className="splash-command__label">connected roles</span>
            </div>
            <div className="splash-command__metric">
              <span className="splash-command__value">24/7</span>
              <span className="splash-command__label">workflow continuity</span>
            </div>
            <div className="splash-command__metric">
              <span className="splash-command__value">100%</span>
              <span className="splash-command__label">traceable handoffs</span>
            </div>
          </div>
          <p className="splash-command__note">
            Designed for disciplined prescribing, protected communications, and dependable fulfillment visibility.
          </p>
        </article>
      </section>
    </div>
  );
}
