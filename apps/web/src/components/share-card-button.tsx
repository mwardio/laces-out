"use client";

import { Check, Share2 } from "lucide-react";
import { useState } from "react";

import styles from "./share-card-button.module.css";

export interface ShareCardAward {
  readonly label: string;
  readonly teamName: string;
  readonly initials: string;
  readonly value: string;
  readonly caption: string;
}

export interface ShareCardPayload {
  readonly leagueName: string;
  readonly week: number;
  readonly sample: boolean;
  readonly awards: readonly ShareCardAward[];
}

interface ShareCardButtonProps {
  readonly payload: ShareCardPayload;
  readonly fileName?: string;
  readonly label?: string;
}

type ShareState =
  | { readonly state: "idle" }
  | { readonly state: "working" }
  | { readonly state: "shared"; readonly message: string }
  | { readonly state: "failed"; readonly message: string };

function canShareFiles(files: readonly File[]): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [...files] })
  );
}

async function copyToClipboard(blob: Blob): Promise<boolean> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  } catch {
    return false;
  }
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Renders the supplied card server-side and hands it to the platform share sheet. Mobile gets the
 * native sheet, desktop falls back to an image clipboard copy, and anything else downloads the
 * file — a share never silently does nothing.
 */
export function ShareCardButton({
  payload,
  fileName = "laces-out-awards.png",
  label = "Share",
}: ShareCardButtonProps) {
  const [status, setStatus] = useState<ShareState>({ state: "idle" });

  async function share() {
    setStatus({ state: "working" });
    try {
      const response = await fetch("/api/share/card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        setStatus({ state: "failed", message: "Card could not be rendered." });
        return;
      }
      const blob = await response.blob();
      const file = new File([blob], fileName, { type: blob.type || "image/png" });
      if (canShareFiles([file])) {
        try {
          await navigator.share({ files: [file], title: `Week ${payload.week} awards` });
          setStatus({ state: "idle" });
          return;
        } catch (error) {
          // A dismissed share sheet is a normal outcome, not a failure worth reporting.
          if (error instanceof DOMException && error.name === "AbortError") {
            setStatus({ state: "idle" });
            return;
          }
        }
      }
      if (await copyToClipboard(blob)) {
        setStatus({ state: "shared", message: "Copied to clipboard" });
        return;
      }
      download(blob, fileName);
      setStatus({ state: "shared", message: "Downloaded" });
    } catch {
      setStatus({ state: "failed", message: "Card could not be rendered." });
    }
  }

  return (
    <span className={styles.wrapper}>
      <button
        className={styles.button}
        type="button"
        onClick={() => void share()}
        disabled={status.state === "working"}
      >
        {status.state === "shared" ? (
          <Check size={13} aria-hidden="true" />
        ) : (
          <Share2 size={13} aria-hidden="true" />
        )}
        {status.state === "working" ? "Rendering…" : label}
      </button>
      {status.state === "shared" || status.state === "failed" ? (
        <span
          className={`${styles.status}${status.state === "failed" ? ` ${styles.error}` : ""}`}
          role="status"
        >
          {status.message}
        </span>
      ) : null}
    </span>
  );
}
