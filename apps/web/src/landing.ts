import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// The standalone page and the app share one source, so product copy cannot drift.
const asset = (name: string) =>
  readFileSync(path.join(process.cwd(), "landing", name), "utf8");
export const LANDING_CSS = asset("landing.css");
export const LANDING_JS = asset("landing.js");
export const ACCESS_CSS = asset("access.css");
export const PROVIDER_LOGOS = {
  gmail: { bytes: readFileSync(path.join(process.cwd(), "landing/providers/gmail.svg")), type: "image/svg+xml" },
  slack: { bytes: readFileSync(path.join(process.cwd(), "landing/providers/slack.png")), type: "image/png" },
  imessage: { bytes: readFileSync(path.join(process.cwd(), "landing/providers/messages.jpg")), type: "image/jpeg" },
} as const;
export const ACCESS_VERSION = createHash("sha256").update(ACCESS_CSS).digest("hex").slice(0, 10);
const version = createHash("sha256")
  .update(LANDING_CSS)
  .update(LANDING_JS)
  .digest("hex")
  .slice(0, 10);
export const LANDING_HTML = asset("index.html")
  .replace("./landing.css", `/static/landing.css?v=${version}`)
  .replace("./landing.js", `/static/landing.js?v=${version}`);
