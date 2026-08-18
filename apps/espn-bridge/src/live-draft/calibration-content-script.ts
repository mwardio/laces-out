/**
 * Browser entry point for the explicitly local ESPN DOM calibration build.
 *
 * There is intentionally no import from the bridge protocol, no chrome.runtime message, no fetch,
 * and no storage. Reports stay in this tab's DevTools console. The production/store manifest never
 * declares this bundle.
 */

import {
  createEspnDraftCalibrationSessionAccumulator,
  createEspnDraftCalibrationReport,
  recognizeEspnDraftCalibrationRoute,
  serializeEspnDraftCalibrationReport,
  serializeEspnDraftCalibrationSessionEvidence,
  type EspnDraftCalibrationReportV1,
  type EspnDraftCalibrationSessionEvidenceV1,
} from "./calibration.js";
import {
  createEspnDraftStructuralDiscoveryReport,
  serializeEspnDraftStructuralDiscoveryReport,
  shouldCreateEspnStructuralDiscoveryReport,
  type EspnDraftStructuralDiscoveryReportV2,
} from "./calibration-discovery.js";
import { ESPN_LIVE_DRAFT_LIMITS } from "./dom-contract.js";
import type { DraftRoomElement } from "./dom-adapter.js";

export const ESPN_CALIBRATION_CONSOLE_MARKER = "LACES_OUT_ESPN_CALIBRATION_V1";
export const ESPN_CALIBRATION_SESSION_CONSOLE_MARKER = "LACES_OUT_ESPN_SESSION_EVIDENCE_V1";
export const ESPN_CALIBRATION_DISCOVERY_CONSOLE_MARKER = "LACES_OUT_ESPN_STRUCTURAL_DISCOVERY_V2";

export function calibrationConsoleLine(report: EspnDraftCalibrationReportV1): string {
  return `${ESPN_CALIBRATION_CONSOLE_MARKER} ${serializeEspnDraftCalibrationReport(report)}`;
}

export function calibrationDiscoveryConsoleLine(
  report: EspnDraftStructuralDiscoveryReportV2,
): string {
  return `${ESPN_CALIBRATION_DISCOVERY_CONSOLE_MARKER} ${serializeEspnDraftStructuralDiscoveryReport(report)}`;
}

export function calibrationSessionEvidenceConsoleLine(
  report: EspnDraftCalibrationSessionEvidenceV1,
): string {
  return `${ESPN_CALIBRATION_SESSION_CONSOLE_MARKER} ${serializeEspnDraftCalibrationSessionEvidence(report)}`;
}

/** Fixed copy only: provider text, URL fragments, and IDs are never interpolated into the page. */
export function calibrationBadgeText(report: EspnDraftCalibrationReportV1): string {
  if (report.structuralVerification === "pass") {
    return "Laces Out: local draft calibration passed; copy the latest safe DevTools reports.";
  }
  if (report.structuralVerification === "inconclusive") {
    return "Laces Out: local draft calibration needs an active nomination; see DevTools.";
  }
  if (shouldCreateEspnStructuralDiscoveryReport(report)) {
    return "Laces Out: selectors missed; copy all safe DevTools reports.";
  }
  return "Laces Out: local draft calibration found a structural mismatch; see DevTools.";
}

interface CalibrationBadge {
  update(report: EspnDraftCalibrationReportV1): void;
  remove(): void;
}

function createCalibrationBadge(): CalibrationBadge {
  let node: HTMLDivElement | null = null;
  let lastText: string | null = null;
  return {
    update(report): void {
      const text = calibrationBadgeText(report);
      if (node !== null && text === lastText) return;
      if (node === null) {
        if (document.body === null) return;
        node = document.createElement("div");
        node.setAttribute("role", "status");
        node.setAttribute("aria-live", "polite");
        node.setAttribute("data-laces-out-espn-calibration", "local-only");
        node.setAttribute(
          "style",
          [
            "position:fixed",
            "right:12px",
            "bottom:56px",
            "z-index:2147483647",
            "max-width:360px",
            "padding:8px 10px",
            "border-radius:6px",
            "background:#18212f",
            "color:#fff",
            "font:12px/1.35 system-ui,sans-serif",
            "box-shadow:0 2px 10px rgba(0,0,0,.35)",
            "pointer-events:none",
          ].join(";"),
        );
        document.body.append(node);
      }
      node.textContent = text;
      lastText = text;
    },
    remove(): void {
      node?.remove();
      node = null;
      lastText = null;
    },
  };
}

export function runLocalEspnDraftCalibration(options: {
  readonly href: string;
  readonly root: DraftRoomElement;
  readonly emit: (line: string) => void;
  readonly badge: CalibrationBadge;
}): { readonly active: boolean; refresh(): void; stop(): void } {
  const route = recognizeEspnDraftCalibrationRoute(options.href, {
    minimum: ESPN_LIVE_DRAFT_LIMITS.minimumSeason,
    maximum: ESPN_LIVE_DRAFT_LIMITS.maximumSeason,
  });
  if (route === null) {
    return { active: false, refresh: () => undefined, stop: () => undefined };
  }

  let lastCalibrationLine: string | null = null;
  let lastSessionEvidenceLine: string | null = null;
  let lastDiscoveryLine: string | null = null;
  let stopped = false;
  const sessionAccumulator = createEspnDraftCalibrationSessionAccumulator(route.roomKind);
  const refresh = (): void => {
    if (stopped) return;
    const report = createEspnDraftCalibrationReport(options.root, route);
    const calibrationLine = calibrationConsoleLine(report);
    const sessionEvidenceLine =
      calibrationLine === lastCalibrationLine
        ? lastSessionEvidenceLine
        : calibrationSessionEvidenceConsoleLine(sessionAccumulator.observe(report));
    const discoveryLine = shouldCreateEspnStructuralDiscoveryReport(report)
      ? calibrationDiscoveryConsoleLine(createEspnDraftStructuralDiscoveryReport(options.root))
      : null;
    if (
      calibrationLine === lastCalibrationLine &&
      sessionEvidenceLine === lastSessionEvidenceLine &&
      discoveryLine === lastDiscoveryLine
    ) {
      return;
    }
    options.badge.update(report);
    if (calibrationLine !== lastCalibrationLine) options.emit(calibrationLine);
    if (sessionEvidenceLine !== null && sessionEvidenceLine !== lastSessionEvidenceLine) {
      options.emit(sessionEvidenceLine);
    }
    if (discoveryLine !== null && discoveryLine !== lastDiscoveryLine) {
      options.emit(discoveryLine);
    }
    lastCalibrationLine = calibrationLine;
    lastSessionEvidenceLine = sessionEvidenceLine;
    lastDiscoveryLine = discoveryLine;
  };
  refresh();
  return {
    active: true,
    refresh,
    stop(): void {
      stopped = true;
      options.badge.remove();
    },
  };
}

function bootstrap(): void {
  const badge = createCalibrationBadge();
  const calibration = runLocalEspnDraftCalibration({
    href: globalThis.location.href,
    root: document.documentElement,
    // Each serialized line is easy to copy and cannot lazily expose a referenced DOM node.
    emit: (line) => console.info(line),
    badge,
  });
  if (!calibration.active) return;

  let refreshHandle: number | null = null;
  const mutations = new MutationObserver(() => {
    if (refreshHandle !== null) globalThis.clearTimeout(refreshHandle);
    // Browsers return a numeric handle; `Number` also keeps the repository's node-inclusive
    // typecheck from selecting NodeJS.Timeout for this browser-only bundle.
    refreshHandle = Number(
      globalThis.setTimeout(() => {
        refreshHandle = null;
        calibration.refresh();
      }, 250),
    );
  });
  mutations.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  globalThis.addEventListener("pagehide", () => {
    mutations.disconnect();
    if (refreshHandle !== null) globalThis.clearTimeout(refreshHandle);
    calibration.stop();
  });
}

if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") bootstrap();
