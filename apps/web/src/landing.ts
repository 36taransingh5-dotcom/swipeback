import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The standalone page and the app share one source, so product copy cannot drift.
const asset = (name: string) =>
  readFileSync(new URL(`../../../landing/${name}`, import.meta.url), "utf8");
export const LANDING_CSS = asset("landing.css");
export const LANDING_JS = asset("landing.js");
const version = createHash("sha256")
  .update(LANDING_CSS)
  .update(LANDING_JS)
  .digest("hex")
  .slice(0, 10);
export const LANDING_HTML = asset("index.html")
  .replace("./landing.css", `/static/landing.css?v=${version}`)
  .replace("./landing.js", `/static/landing.js?v=${version}`)
  .replace("<!--REVIEWER_LINK-->", '<a href="/login">Reviewer sign in ↗</a>');
