import { ImageResponse } from "next/og";

export const alt = "Laces Out — Know the room. Make the move.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        padding: "62px 70px",
        color: "#f4f6f3",
        background: "#101712",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          width: "100%",
          flexDirection: "column",
          justifyContent: "space-between",
          borderTop: "1px solid #384238",
          borderBottom: "1px solid #384238",
          padding: "30px 0 36px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 17 }}>
          <div
            style={{
              display: "flex",
              width: 52,
              height: 52,
              alignItems: "center",
              justifyContent: "center",
              color: "#101712",
              background: "#c5e878",
              borderRadius: 11,
            }}
          >
            <svg width="48" height="48" viewBox="0 0 64 64" aria-hidden="true">
              <path d="M18.1 48.8h27.8l3.4 7H14.7Z" fill="#101712" />
              <path
                d="M17.5 51.3h29"
                fill="none"
                stroke="#c5e878"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <circle cx="32" cy="29.5" r="21.5" fill="#101712" />
              <circle cx="32" cy="29.5" r="20.2" fill="none" stroke="#347158" strokeWidth="1.8" />
              <path
                d="M18.4 29.2c.2-7.1 4.2-13.2 10.2-16.1"
                fill="none"
                stroke="#edf5d9"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
              <path
                d="M32 12.7c-6.2 3.2-9.6 9.7-9.6 17.8S25.8 45.2 32 48.4c6.2-3.2 9.6-9.8 9.6-17.9S38.2 15.9 32 12.7Z"
                fill="#c5e878"
              />
              <path
                d="M32 19.2v22.6"
                fill="none"
                stroke="#101712"
                strokeWidth="2.35"
                strokeLinecap="round"
              />
              <path
                d="M27.8 24.1h8.4m-9.1 3.9h9.8m-9.8 3.9h9.8m-9.1 3.9h8.4"
                fill="none"
                stroke="#101712"
                strokeWidth="2.15"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 34, fontWeight: 750, letterSpacing: "-0.7px" }}>
              Laces Out
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ display: "flex", maxWidth: 850, flexDirection: "column" }}>
            <span
              style={{
                color: "#c5e878",
                fontSize: 14,
                fontWeight: 750,
                letterSpacing: "2.2px",
                textTransform: "uppercase",
              }}
            >
              Draft night through championship week
            </span>
            <span
              style={{
                marginTop: 18,
                fontSize: 72,
                fontWeight: 700,
                letterSpacing: "-4.5px",
                lineHeight: 0.96,
              }}
            >
              Know the room.
              <br />
              Make the move.
            </span>
          </div>

          <div
            style={{
              display: "flex",
              width: 116,
              height: 184,
              alignItems: "center",
              justifyContent: "center",
              border: "2px solid #c5e878",
              borderRadius: "58% 42% 58% 42%",
              transform: "rotate(39deg)",
            }}
          >
            <div
              style={{
                display: "flex",
                width: 3,
                height: 112,
                background: "#c5e878",
                borderRadius: 2,
              }}
            />
          </div>
        </div>
      </div>
    </div>,
    size,
  );
}
