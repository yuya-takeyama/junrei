/**
 * `@junrei/capture-proxy` — the localhost-only, opt-in wire-capture proxy
 * (Goshuin Phase D, docs/milestones/goshuin.md). Public surface for embedding
 * and testing; the runnable entry point is `main.ts` (bin `junrei-capture-proxy`).
 */

export {
  DEFAULT_PORT,
  DEFAULT_UPSTREAM,
  type ProxyArgs,
  parseArgs,
  resolveCapturesDir,
} from "./args.js";
export { type BannerContext, bannerLines, printBanner, usageLine } from "./banner.js";
export {
  appendCapture,
  type CaptureEntry,
  captureFileName,
  detectIsSubagent,
  extractRequestId,
  extractSessionId,
  REQUEST_ID_HEADER,
  SESSION_ID_HEADER,
  sanitizeSessionId,
  UNASSIGNED_FILENAME,
} from "./capture.js";
export {
  BIND_HOST,
  createProxyServer,
  type ProxyHooks,
  type ProxyOptions,
  type RunningProxy,
  startCaptureProxy,
} from "./proxy.js";
export { REDACTED, redactHeaders, shouldRedactHeader } from "./redact.js";
export { assembleMessage, parseSse, type SseEvent, tryParseJson } from "./sse.js";
