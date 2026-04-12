const FEEDBACK_META = {
  success: {
    icon: "OK",
    label: "Success",
  },
  completion: {
    icon: "OK",
    label: "Completed",
  },
  warning: {
    icon: "!",
    label: "Warning",
  },
  error: {
    icon: "X",
    label: "Error",
  },
  info: {
    icon: "i",
    label: "Update",
  },
};

export default function GlobalFeedbackOverlay({
  successMessage = "",
  completionMessage = "",
  warningMessage = "",
  errorMessage = "",
  infoMessage = "",
  onClose,
}) {
  const candidate =
    (errorMessage && { tone: "error", text: errorMessage }) ||
    (warningMessage && { tone: "warning", text: warningMessage }) ||
    (completionMessage && { tone: "completion", text: completionMessage }) ||
    (successMessage && { tone: "success", text: successMessage }) ||
    (infoMessage && { tone: "info", text: infoMessage }) ||
    null;

  if (!candidate?.text) return null;

  const meta = FEEDBACK_META[candidate.tone] || FEEDBACK_META.info;

  return (
    <div className="feedback-overlay" role="presentation">
      <button
        type="button"
        className="feedback-overlay__scrim"
        aria-label="Dismiss message"
        onClick={onClose}
      />
      <div
        className={`feedback-overlay__card feedback-overlay__card--${candidate.tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-live="assertive"
      >
        <div className="feedback-overlay__header">
          <div className="feedback-overlay__title-wrap">
            <span className="feedback-overlay__icon" aria-hidden="true">
              {meta.icon}
            </span>
            <div>
              <div className="feedback-overlay__eyebrow">Global message</div>
              <h3 className="feedback-overlay__title">{meta.label}</h3>
            </div>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="feedback-overlay__message">{candidate.text}</p>
      </div>
    </div>
  );
}
