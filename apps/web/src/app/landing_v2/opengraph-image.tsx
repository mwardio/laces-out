import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { yahooComingSoon } from "../../lib/public-site";

export const alt = "Laces Out: Connect your leagues. Get the next move.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const workspaceWebPath = join("apps", "web");
const webProjectDirectory = process.cwd().endsWith(workspaceWebPath)
  ? process.cwd()
  : join(process.cwd(), workspaceWebPath);

function emittedAssetPath(asset: string | URL): string {
  const relativePath = String(asset).replace(/^\/_next\//u, "");
  return join(webProjectDirectory, ".next", "server", "chunks", relativePath);
}

const soraBold = readFile(emittedAssetPath(new URL("../fonts/Sora-Bold.ttf", import.meta.url)));
const markSource = readFile(
  join(webProjectDirectory, "public", "brand", "laces-out-playbook-mark.png"),
).then((data) => Uint8Array.from(data).buffer);

export default async function OpenGraphImage() {
  const [fontData, mark] = await Promise.all([soraBold, markSource]);

  return new ImageResponse(
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "58px 68px",
        color: "#f6f7f5",
        background: "#101712",
        fontFamily: "Sora",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <img src={mark as unknown as string} alt="" width={62} height={62} />
        <div
          style={{
            display: "flex",
            fontSize: 29,
            fontWeight: 700,
            letterSpacing: "-1.2px",
          }}
        >
          Laces Out
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            fontSize: 76,
            fontWeight: 700,
            letterSpacing: "-3.2px",
            lineHeight: 1.03,
          }}
        >
          Connect your leagues.
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 2,
            color: "#c5e878",
            fontSize: 76,
            fontWeight: 700,
            letterSpacing: "-3.2px",
            lineHeight: 1.03,
          }}
        >
          Get the next move.
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 24,
          color: "#a7b1a9",
          fontSize: 20,
        }}
      >
        <div style={{ display: "flex" }}>{yahooComingSoon ? "ESPN" : "Yahoo + ESPN"}</div>
        <div style={{ display: "flex", color: "#566159" }}>•</div>
        <div style={{ display: "flex" }}>Web + iPhone</div>
        <div style={{ display: "flex", color: "#566159" }}>•</div>
        <div style={{ display: "flex" }}>Backtested across 4 NFL seasons</div>
      </div>
    </div>,
    {
      ...size,
      fonts: [{ name: "Sora", data: fontData, style: "normal", weight: 700 }],
    },
  );
}
