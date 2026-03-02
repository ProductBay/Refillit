export default function Home() {
  return (
    <>
      <section className="hero">
        <div className="tagline">Digital Prescription Network</div>
        <h1>Coordinate doctor, patient, pharmacy, and delivery in one flow.</h1>
        <p className="subhead">
          Refillit runs secure prescriptions, refill orders, dispatch handoff, NHF claims,
          and operational audit trails.
        </p>
      </section>
      <section className="grid">
        {[
          "Doctor writes and signs prescriptions",
          "Patient links script and submits order",
          "Pharmacy verifies and updates fulfillment",
          "Courier receives assignment and closes POD",
        ].map((text) => (
          <article key={text} className="card">
            <h3>{text}</h3>
            <p>Live API-backed workflow with role gates and audit logging.</p>
          </article>
        ))}
      </section>
    </>
  );
}
