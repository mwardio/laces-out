"use client";

import {
  ArrowLeft,
  Check,
  Download,
  FileJson,
  FileSpreadsheet,
  Link2,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { apiBaseUrl } from "../lib/api-client";

interface SharedBoard {
  readonly list: {
    readonly id: string;
    readonly name: string;
    readonly description: string | null;
    readonly season: number;
    readonly kind: string;
    readonly scoringContext: { readonly label: string | null; readonly format: string };
  };
  readonly version: {
    readonly id: string;
    readonly versionNumber: number;
    readonly state: "draft" | "published";
    readonly createdAt: string;
    readonly checksumSha256: string;
    readonly entries: readonly {
      readonly playerId: string;
      readonly position: string | null;
      readonly overallRank: { readonly value: number } | null;
      readonly tier: { readonly value: number } | null;
      readonly adp: { readonly value: number } | null;
      readonly aav: { readonly value: number } | null;
      readonly targetPrice: { readonly value: number } | null;
      readonly notes: { readonly value: string } | null;
      readonly target: { readonly value: boolean } | null;
      readonly avoid: { readonly value: boolean } | null;
    }[];
    readonly provenance: {
      readonly operation: string;
      readonly sources: readonly { readonly label: string | null; readonly kind: string }[];
    };
  };
  readonly players: readonly {
    readonly id: string;
    readonly fullName: string;
    readonly position: string;
  }[];
  readonly allowCopy: boolean;
}

function errorMessage(value: unknown): string {
  if (typeof value !== "object" || value === null) return "This share is unavailable.";
  const record = value as Record<string, unknown>;
  return typeof record.title === "string" ? record.title : "This share is unavailable.";
}

export function SharedRankingViewer() {
  const [token, setToken] = useState<string | null>(null);
  const [board, setBoard] = useState<SharedBoard | null>(null);
  const [state, setState] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState("Opening the protected ranking snapshot…");

  useEffect(() => {
    const candidate = window.location.hash.slice(1);
    if (!/^frs_[A-Za-z0-9_-]{43}$/u.test(candidate)) {
      setState("error");
      setMessage("This link does not contain a valid ranking access key.");
      return;
    }
    setToken(candidate);
    void fetch(`${apiBaseUrl}/v1/ranking-shares/open`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ token: candidate }),
    })
      .then(async (response) => {
        const value: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(errorMessage(value));
        setBoard(value as SharedBoard);
        setState("done");
      })
      .catch((error: unknown) => {
        setState("error");
        setMessage(error instanceof Error ? error.message : "This share is unavailable.");
      });
  }, []);

  const names = useMemo(
    () => new Map(board?.players.map((player) => [player.id, player.fullName]) ?? []),
    [board],
  );

  async function exportShared(format: "json" | "csv") {
    if (!token || !board) return;
    setMessage(`Preparing ${format.toUpperCase()}…`);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/ranking-shares/export`, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: format === "csv" ? "text/csv" : "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token, format }),
      });
      if (!response.ok) throw new Error("The share export is unavailable.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${board.list.name.replace(/[^a-z0-9]+/giu, "-").toLowerCase() || "rankings"}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(`${format.toUpperCase()} export created.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The export failed.");
    }
  }

  if (state !== "done" || !board) {
    return (
      <section
        className={`panel shared-ranking-state shared-ranking-state--${state}`}
        role={state === "error" ? "alert" : "status"}
        aria-live="polite"
      >
        {state === "working" ? (
          <LoaderCircle className="spin" size={28} />
        ) : (
          <TriangleAlert size={28} />
        )}
        <h1>{state === "working" ? "Opening private board" : "Share unavailable"}</h1>
        <p>{message}</p>
        {state === "error" ? (
          <Link className="button button--dark" href="/rankings">
            <ArrowLeft size={15} /> Rankings Studio
          </Link>
        ) : null}
      </section>
    );
  }

  return (
    <div className="shared-ranking-page">
      <section className="page-heading shared-ranking-heading">
        <div>
          <h1>{board.list.name}</h1>
          <p className="page-subtitle">
            {board.list.description ?? "A private Laces Out ranking board."}
          </p>
        </div>
        <div className="shared-ranking-trust">
          <ShieldCheck size={18} />
          <span>
            <strong>Private link</strong>
            <small>The access key stays in your browser.</small>
          </span>
        </div>
      </section>

      <section className="panel shared-ranking-meta">
        <div>
          <span>{board.list.season}</span>
          <strong>{board.list.kind.replaceAll("-", " ")}</strong>
        </div>
        <div>
          <span>Scoring</span>
          <strong>{board.list.scoringContext.label ?? board.list.scoringContext.format}</strong>
        </div>
        <div>
          <span>Version</span>
          <strong>
            v{board.version.versionNumber} · {board.version.state}
          </strong>
        </div>
        <div>
          <span>Integrity</span>
          <strong className="shared-ranking-sha">
            {board.version.checksumSha256.slice(0, 12)}
          </strong>
        </div>
      </section>

      <section className="panel shared-ranking-board">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">{board.version.entries.length} players</p>
            <h2>Ranked board</h2>
            <p>
              {board.version.provenance.operation} ·{" "}
              {board.version.provenance.sources
                .map((source) => source.label ?? source.kind)
                .join(" + ") || "manual"}
            </p>
          </div>
          {board.allowCopy ? (
            <div className="shared-ranking-actions">
              <button
                className="button button--outline button--small"
                type="button"
                onClick={() => void exportShared("csv")}
              >
                <FileSpreadsheet size={14} /> CSV
              </button>
              <button
                className="button button--dark button--small"
                type="button"
                onClick={() => void exportShared("json")}
              >
                <FileJson size={14} /> JSON
              </button>
            </div>
          ) : null}
        </div>
        <div className="shared-ranking-capability">
          <Link2 size={14} />
          <span>{board.allowCopy ? "Owner permits copying this board." : "View-only share."}</span>
          {message !== "Opening the protected ranking snapshot…" ? <small>{message}</small> : null}
        </div>
        <div
          className="ranking-table-wrap"
          role="region"
          aria-label="Shared ranking board; scroll horizontally to view all columns"
          tabIndex={0}
        >
          <table className="ranking-table shared-ranking-table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Player</th>
                <th scope="col">Pos</th>
                <th scope="col">Tier</th>
                <th scope="col">ADP</th>
                <th scope="col">AAV</th>
                <th scope="col">Target $</th>
                <th scope="col">Notes</th>
                <th scope="col">Signal</th>
              </tr>
            </thead>
            <tbody>
              {board.version.entries.map((entry) => (
                <tr key={entry.playerId}>
                  <td className="shared-ranking-rank">{entry.overallRank?.value ?? "—"}</td>
                  <td>
                    <strong>{names.get(entry.playerId) ?? "Unknown player"}</strong>
                    <small>{entry.playerId.slice(0, 8)}</small>
                  </td>
                  <td>{entry.position ?? "—"}</td>
                  <td>{entry.tier?.value ?? "—"}</td>
                  <td>{entry.adp?.value ?? "—"}</td>
                  <td>{entry.aav?.value ?? "—"}</td>
                  <td>{entry.targetPrice?.value ?? "—"}</td>
                  <td>{entry.notes?.value ?? ""}</td>
                  <td>
                    {entry.target?.value ? (
                      <span className="shared-ranking-signal shared-ranking-signal--target">
                        <Check size={11} /> Target
                      </span>
                    ) : entry.avoid?.value ? (
                      <span className="shared-ranking-signal shared-ranking-signal--avoid">
                        Avoid
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="shared-ranking-footer">
        <Link href="/rankings">
          <ArrowLeft size={14} /> Build your own board
        </Link>
        <span>
          <Download size={13} /> Portable and source-aware
        </span>
      </div>
    </div>
  );
}
