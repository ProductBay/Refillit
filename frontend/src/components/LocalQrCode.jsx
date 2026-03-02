import { useEffect, useRef } from "react";
import { BrowserQRCodeSvgWriter } from "@zxing/library";

export default function LocalQrCode({
  value,
  size = 220,
  className = "",
  title = "QR code",
}) {
  const hostRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = "";
    const raw = String(value || "").trim();
    if (!raw) return;
    try {
      const writer = new BrowserQRCodeSvgWriter();
      const svg = writer.write(raw, Number(size || 220), Number(size || 220));
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", title);
      if (className) svg.setAttribute("class", className);
      host.appendChild(svg);
    } catch (_err) {
      // Keep panel stable if QR rendering fails.
    }
  }, [value, size, className, title]);

  return <div ref={hostRef} />;
}

