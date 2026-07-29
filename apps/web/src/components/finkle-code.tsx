"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { FINKLE_KICK_EVENT } from "../lib/finkle-kick";
import styles from "./finkle-code.module.css";

const TAP_WINDOW_MS = 700;
const STAGE_WIDTH = 1280;
const STAGE_HEIGHT = 720;
/** Reduced motion holds the closing card for the length of the verdict scene, then leaves. */
const STATIC_CARD_MS = 2800;

type Phase = "idle" | "playing";
type Ease = (progress: number) => number;

// ── Math ────────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

const easeLinear: Ease = (t) => t;
const easeInQuad: Ease = (t) => t * t;
const easeOutQuad: Ease = (t) => t * (2 - t);
const easeInOutQuad: Ease = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
const easeInCubic: Ease = (t) => t * t * t;
const easeOutCubic: Ease = (t) => (t - 1) * (t - 1) * (t - 1) + 1;
const easeInOutCubic: Ease = (t) =>
  t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;
const easeInOutQuart: Ease = (t) =>
  t < 0.5 ? 8 * t * t * t * t : 1 - 8 * (t - 1) * (t - 1) * (t - 1) * (t - 1);
const easeInOutSine: Ease = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const easeOutBack: Ease = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** Eased sub-segment: 0 before `from`, 1 after `to`, eased in between. */
function segment(p: number, from: number, to: number, ease: Ease = easeInOutCubic): number {
  return ease(clamp((p - from) / (to - from), 0, 1));
}

/** Deterministic hash noise — the broadcast grit has to be the same every playthrough. */
function noise(index: number): number {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

// ── World geometry (1280x720 stage over a 1360x790 world plane) ─────────────

const WORLD_WIDTH = 1360;
const WORLD_HEIGHT = 790;
const HOLD_X = 588;
const HOLD_Y = 596;

interface FlightPoint {
  readonly x: number;
  readonly y: number;
  readonly s: number;
  readonly rot: number;
}

/** The 26-yarder: right of the upright plane by u ≈ 0.55, into the crowd by u = 1. */
function flight(u: number): FlightPoint {
  const k = u * 0.8;
  return {
    x: HOLD_X + 330 * Math.pow(u, 1.55),
    y: HOLD_Y - 1720 * k * (1 - k),
    s: 1 - 0.74 * easeOutQuad(u),
    rot: 760 * u,
  };
}

const LANDING = flight(1);

const YARD_STOPS = [382, 384.8, 400, 425.5, 462, 510, 568.5, 638.6, 712, 790] as const;

const MOW_STRIPES = YARD_STOPS.flatMap((top, index) =>
  index % 2 === 1 && index < YARD_STOPS.length - 1
    ? [{ top, height: (YARD_STOPS[index + 1] ?? top) - top }]
    : [],
);

const YARD_LINES = YARD_STOPS.slice(1, 9).map((top, index) => ({
  top,
  height: 1.2 + index * 0.75,
}));

const FLASH_BULBS = Array.from({ length: 16 }, (_, index) => ({
  x: 30 + noise(index * 3 + 1) * 1300,
  y: 262 + noise(index * 7 + 2) * 104,
}));

interface CameraState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const WIDE_CAM: CameraState = { x: 640, y: 410, z: 1.1 };
const HOLD_CAM: CameraState = { x: 614, y: 556, z: 2.5 };

function cameraTransform(cam: CameraState): string {
  const { z } = cam;
  const cx = clamp(cam.x, STAGE_WIDTH / 2 / z, WORLD_WIDTH - STAGE_WIDTH / 2 / z);
  const cy = clamp(cam.y, STAGE_HEIGHT / 2 / z, WORLD_HEIGHT - STAGE_HEIGHT / 2 / z);
  return `translate(${STAGE_WIDTH / 2 - cx * z}px, ${STAGE_HEIGHT / 2 - cy * z}px) scale(${z})`;
}

// ── World pieces ────────────────────────────────────────────────────────────

interface BallState {
  readonly x: number;
  readonly y: number;
  readonly s: number;
  readonly rot: number;
  /** 0 = laces facing the camera (and the kicker), 1 = laces hidden behind the ball. */
  readonly laces: number;
  readonly squash: number;
  readonly opacity: number;
  readonly shadow: boolean;
}

function Ball({ ball }: Readonly<{ ball: BallState }>) {
  const angle = clamp(ball.laces, -0.25, 1);
  const offset = 26 * Math.sin((angle * Math.PI) / 2);
  const width = Math.max(0, 11 * Math.cos((Math.min(1, Math.abs(angle)) * Math.PI) / 2));
  return (
    <>
      {ball.shadow ? (
        <div
          className={styles.ballShadow}
          style={{ left: ball.x - 26, transform: `scale(${ball.s})` }}
        />
      ) : null}
      <div
        className={styles.ball}
        style={{
          left: ball.x,
          top: ball.y,
          opacity: ball.opacity,
          transform: `rotate(${ball.rot}deg) scale(${ball.s}) scaleY(${ball.squash})`,
        }}
      >
        <div className={styles.ballSkin} />
        {width > 0.5 ? (
          <div className={styles.ballLaces} style={{ left: 23 + offset - width / 2, width }} />
        ) : null}
      </div>
    </>
  );
}

function Goalposts({ t, wobble }: Readonly<{ t: number; wobble: number }>) {
  const pennant = (left: number, phase: number) => (
    <div
      className={styles.pennant}
      style={{ left, transform: `rotate(${10 * Math.sin(t * 2.8 + phase) - 4}deg)` }}
    />
  );
  return (
    <>
      <div className={styles.postPole} />
      <div className={styles.postBase} />
      <div className={styles.crossbar} />
      <div className={`${styles.upright} ${styles.uprightLeft}`} />
      <div
        className={`${styles.upright} ${styles.uprightRight}`}
        style={{ transform: `rotate(${wobble}deg)` }}
      />
      {pennant(563, 0)}
      {pennant(715 + wobble * 2, 2)}
    </>
  );
}

interface WorldFieldProps {
  readonly t: number;
  readonly cam: CameraState;
  readonly jitterX?: number;
  readonly ball?: BallState | null;
  readonly wobble?: number;
  /** Expanding impact ring in the stands, 0 → 1. */
  readonly impact?: number;
  readonly flashK?: number;
  readonly children?: ReactNode;
}

function WorldField({
  t,
  cam,
  jitterX = 0,
  ball = null,
  wobble = 0,
  impact = 0,
  flashK = 0,
  children,
}: WorldFieldProps) {
  return (
    <div className={styles.world}>
      <div
        className={styles.worldPlane}
        style={{ transform: `translate(${jitterX}px, 0px) ${cameraTransform(cam)}` }}
      >
        <div className={styles.sky} />
        <div className={`${styles.crowd} ${styles.crowdUpper}`} />
        <div className={`${styles.crowd} ${styles.crowdLower}`} />
        {FLASH_BULBS.map((bulb, index) => {
          const lit = noise(Math.floor(t * 7) * 17 + index * 3) > 1 - 0.05 - 0.3 * flashK;
          return (
            <div
              className={styles.flashBulb}
              key={index}
              style={{ left: bulb.x, top: bulb.y, opacity: lit ? 0.95 : 0 }}
            />
          );
        })}
        <div className={styles.wall} />
        <div className={styles.grass} />
        {MOW_STRIPES.map((stripe) => (
          <div
            className={styles.mowStripe}
            key={stripe.top}
            style={{ top: stripe.top, height: stripe.height }}
          />
        ))}
        {YARD_LINES.map((line) => (
          <div
            className={styles.yardLine}
            key={line.top}
            style={{ top: line.top, height: line.height }}
          />
        ))}
        <Goalposts t={t} wobble={wobble} />
        <div className={styles.tee} />
        {ball ? <Ball ball={ball} /> : null}
        {impact > 0 && impact < 1 ? (
          <div className={styles.impactAnchor} style={{ left: LANDING.x, top: LANDING.y }}>
            <div
              className={styles.impactRing}
              style={{
                left: -lerp(6, 52, impact),
                top: -lerp(5, 40, impact),
                width: lerp(12, 104, impact),
                height: lerp(10, 80, impact),
                opacity: (1 - impact) * 0.9,
              }}
            />
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

interface TelestratorProps {
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
  readonly draw: number;
  readonly fade: number;
}

function Telestrator({ cx, cy, rx, ry, draw, fade }: TelestratorProps) {
  if (draw <= 0.01 || fade >= 0.99) {
    return null;
  }
  const length = Math.PI * 2 * Math.sqrt((rx * rx + ry * ry) / 2);
  return (
    <svg
      className={styles.telestrator}
      viewBox={`0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`}
      fill="none"
      aria-hidden="true"
    >
      <ellipse
        cx={cx}
        cy={cy}
        rx={rx}
        ry={ry}
        stroke="var(--red-600)"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - draw)}
        opacity={1 - fade}
        transform={`rotate(-14 ${cx} ${cy})`}
      />
    </svg>
  );
}

// ── Broadcast chrome (screen space) ─────────────────────────────────────────

function LiveBug({ o, t }: Readonly<{ o: number; t: number }>) {
  return (
    <div className={`${styles.chip} ${styles.liveBug}`} style={{ opacity: o }}>
      <span className={styles.roundDot} style={{ opacity: 0.55 + 0.45 * Math.sin(t * 5) }} />
      Live
    </div>
  );
}

function NetworkBug({ o }: Readonly<{ o: number }>) {
  return (
    <div className={`${styles.chip} ${styles.netBug}`} style={{ opacity: o }}>
      <span className={styles.squareDot} />
      LO Sports
    </div>
  );
}

function TimeStamp({ o }: Readonly<{ o: number }>) {
  return (
    <div className={styles.timestamp} style={{ opacity: o }}>
      SB XVII · 01·30·83 · ORANGE BOWL
    </div>
  );
}

function ScoreBug({ o, slide = 0, clock }: Readonly<{ o: number; slide?: number; clock: string }>) {
  return (
    <div
      className={styles.scoreBug}
      style={{ opacity: o, transform: `translate(-50%, ${slide}px)` }}
    >
      <div className={`${styles.scoreCell} ${styles.scoreGame}`}>SB XVII</div>
      <div className={`${styles.scoreCell} ${styles.scoreHome}`}>MIA 15</div>
      <div className={`${styles.scoreCell} ${styles.scoreAway}`}>WSH 17</div>
      <div className={`${styles.scoreCell} ${styles.scoreClock}`}>{`Q4 ${clock}`}</div>
    </div>
  );
}

interface LowerThirdProps {
  readonly o: number;
  readonly ty: number;
  readonly title: string;
  readonly sub: string;
}

function LowerThird({ o, ty, title, sub }: LowerThirdProps) {
  if (o <= 0.01) {
    return null;
  }
  return (
    <div
      className={styles.lowerThird}
      style={{ opacity: o, transform: `translate(-50%, ${ty}px)` }}
    >
      <div className={styles.lowerTitle}>{title}</div>
      <div className={styles.lowerClear} />
      <div className={styles.lowerSub}>{sub}</div>
    </div>
  );
}

function Caption({ o, text }: Readonly<{ o: number; text: string }>) {
  if (o <= 0.01) {
    return null;
  }
  return (
    <div className={styles.caption} style={{ opacity: o }}>
      {text}
    </div>
  );
}

function Banner({ k }: Readonly<{ k: number }>) {
  if (k <= 0.01) {
    return null;
  }
  return (
    <div
      className={styles.banner}
      style={{
        opacity: Math.min(1, k * 1.5),
        transform: `translate(-50%, ${lerp(60, 0, k)}px) rotate(-1.5deg)`,
      }}
    >
      WIDE RIGHT. NO GOOD.
    </div>
  );
}

function Scream({ p }: Readonly<{ p: number }>) {
  if (p < 0.04 || p > 0.28) {
    return null;
  }
  const grow = segment(p, 0.04, 0.12, easeOutBack);
  const out = segment(p, 0.2, 0.27, easeInCubic);
  const shake = (noise(Math.floor(p * 90)) - 0.5) * 8 * (1 - out);
  const scale = Math.max(0.001, grow * (1 + 0.3 * out));
  return (
    <div
      className={styles.scream}
      style={{
        opacity: 1 - out,
        transform: `translateY(${shake}px) scale(${scale}) skew(-6deg, 0deg) rotate(-3deg)`,
      }}
    >
      LACES OUT, DAN!
    </div>
  );
}

function CathodeRay({ t, heavy = false }: Readonly<{ t: number; heavy?: boolean }>) {
  return (
    <div className={styles.crt}>
      <div className={styles.crtScan} style={{ opacity: heavy ? 1 : 0.75 }} />
      <div className={styles.crtGrille} />
      <div className={styles.crtVignette} />
      <div
        className={styles.crtFlicker}
        style={{ opacity: 0.015 + 0.02 * noise(Math.floor(t * 16)) }}
      />
    </div>
  );
}

function TvStatic({ t, k }: Readonly<{ t: number; k: number }>) {
  if (k <= 0.02) {
    return null;
  }
  const seed = Math.floor(t * 30);
  return (
    <div className={styles.tvStatic} style={{ opacity: k }}>
      <svg
        className={styles.tvStaticNoise}
        width="100%"
        height="100%"
        key={seed}
        aria-hidden="true"
      >
        <filter id="finkle-tv-noise">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={seed} />
          <feColorMatrix
            type="matrix"
            values="0.9 0.9 0.9 0 -0.7  0.9 0.9 0.9 0 -0.7  0.9 0.9 0.9 0 -0.68  0 0 0 0 1"
          />
        </filter>
        <rect width="100%" height="100%" filter="url(#finkle-tv-noise)" />
      </svg>
      <div
        className={`${styles.tear} ${styles.tearWide}`}
        style={{
          top: `${18 + noise(seed) * 60}%`,
          transform: `translateX(${(noise(seed + 9) - 0.5) * 60}px)`,
        }}
      />
      <div
        className={`${styles.tear} ${styles.tearThin}`}
        style={{ top: `${55 + noise(seed + 3) * 30}%` }}
      />
    </div>
  );
}

// ── Scenes ──────────────────────────────────────────────────────────────────

interface SceneProps {
  /** Seconds since this scene started. */
  readonly t: number;
  /** Progress through this scene, 0 → 1. */
  readonly p: number;
}

function OnAirScene({ t, p }: SceneProps) {
  const push = segment(p, 0, 1, easeInOutSine);
  const cam = { x: 640, y: lerp(395, WIDE_CAM.y, push), z: lerp(1.04, WIDE_CAM.z, push) };
  const grain = 1 - segment(p, 0.05, 0.17, easeOutQuad);
  const chrome = segment(p, 0.16, 0.28, easeOutCubic);
  const lower = Math.min(
    segment(p, 0.36, 0.46, easeOutCubic),
    1 - segment(p, 0.84, 0.94, easeInCubic),
  );
  return (
    <>
      <WorldField t={t} cam={cam} flashK={0.3} />
      <LiveBug o={chrome} t={t} />
      <NetworkBug o={chrome} />
      <TimeStamp o={chrome} />
      <ScoreBug o={chrome} slide={(1 - chrome) * 40} clock="0:04" />
      <LowerThird
        o={lower}
        ty={(1 - lower) * 16}
        title="FINKLE ON FOR THE 26-YARD WINNER"
        sub="0:04 left in the 4th · this is for the ring"
      />
      <CathodeRay t={t} />
      <TvStatic t={t} k={grain} />
    </>
  );
}

function TheHoldScene({ t, p }: SceneProps) {
  const move = segment(p, 0.04, 0.3, easeInOutQuart);
  const drift = Math.sin(Math.PI * p);
  const cam = {
    x: lerp(WIDE_CAM.x, HOLD_CAM.x, move) + 2.4 * Math.sin(t * 1.6) * drift,
    y: lerp(WIDE_CAM.y, HOLD_CAM.y, move) + 1.6 * Math.sin(t * 2.1 + 1) * drift,
    z: lerp(WIDE_CAM.z, HOLD_CAM.z, move),
  };
  let ball: BallState | null = null;
  if (p >= 0.12) {
    const snap = segment(p, 0.12, 0.27, easeOutQuad);
    const caught = segment(p, 0.27, 0.38, easeOutBack);
    ball = {
      x: lerp(662, HOLD_X, snap),
      y: lerp(486, HOLD_Y, snap) - 34 * Math.sin(Math.PI * snap),
      s: lerp(0.5, 1, snap),
      rot: lerp(-400, 0, easeOutCubic(snap)),
      // The crime: the laces swing around to face the kicker.
      laces: p < 0.42 ? 1 : 1 - segment(p, 0.42, 0.6, easeOutBack),
      squash: p < 0.27 ? 1 : lerp(0.8, 1, caught),
      opacity: 1,
      shadow: snap > 0.5,
    };
  }
  const caption = Math.min(segment(p, 0.3, 0.4), 1 - segment(p, 0.78, 0.88));
  return (
    <>
      <WorldField t={t} cam={cam} ball={ball} flashK={0.25} />
      <LiveBug o={1} t={t} />
      <NetworkBug o={1} />
      <TimeStamp o={1} />
      <ScoreBug o={1} clock="0:04" />
      <Caption o={caption} text="the hold is down…" />
      <CathodeRay t={t} />
    </>
  );
}

function TheKickScene({ t, p }: SceneProps) {
  const pull = segment(p, 0.06, 0.3, easeInOutQuart);
  const u = segment(p, 0.34, 0.74, easeLinear);
  const shot = flight(u);
  const drift = Math.sin(Math.PI * p);
  let cam: CameraState = {
    x: lerp(HOLD_CAM.x, WIDE_CAM.x, pull) + 2 * Math.sin(t * 1.7) * drift * (1 - pull),
    y: lerp(HOLD_CAM.y, WIDE_CAM.y, pull),
    z: lerp(HOLD_CAM.z, WIDE_CAM.z, pull),
  };
  if (p >= 0.34) {
    const track = segment(p, 0.34, 0.46, easeOutQuad);
    const settle = segment(p, 0.78, 0.92, easeInOutCubic);
    const kick = Math.max(0, 1 - (p - 0.34) / 0.08);
    const tx = 640 + (shot.x - 640) * 0.38;
    const ty = 410 + (shot.y - 410) * 0.34;
    cam = {
      x:
        lerp(lerp(cam.x, tx, track), WIDE_CAM.x, settle) +
        (noise(Math.floor(t * 40)) - 0.5) * 7 * kick,
      y:
        lerp(lerp(cam.y, ty, track), WIDE_CAM.y, settle) +
        (noise(Math.floor(t * 40) + 7) - 0.5) * 5 * kick,
      z: WIDE_CAM.z + 0.05 * Math.sin(Math.PI * u) * (1 - settle),
    };
  }
  const lean = segment(p, 0.29, 0.335, easeInOutQuad);
  const ball: BallState = {
    x: shot.x,
    y: shot.y,
    s: shot.s,
    rot: u > 0 ? shot.rot : -7 * lean,
    laces: lerp(0, 0.35, Math.min(1, u * 5)),
    squash: 1,
    opacity: 1 - segment(p, 0.74, 0.78),
    shadow: u === 0,
  };
  const wobble =
    p > 0.56
      ? 5.5 * Math.sin((p - 0.56) * 30) * Math.pow(Math.max(0, 1 - (p - 0.56) / 0.3), 1.6)
      : 0;
  const impact = segment(p, 0.74, 0.9, easeOutCubic);
  const flash = p >= 0.74 ? 0.45 * (1 - segment(p, 0.74, 0.8)) : 0;
  const banner = segment(p, 0.78, 0.88, easeOutBack);
  const clock =
    p < 0.34 ? "0:04" : p < 0.42 ? "0:03" : p < 0.5 ? "0:02" : p < 0.58 ? "0:01" : "0:00";
  return (
    <>
      <WorldField
        t={t}
        cam={cam}
        ball={ball}
        wobble={wobble}
        impact={impact}
        flashK={lerp(0.3, 1, segment(p, 0.6, 0.8))}
      />
      {flash > 0.01 ? <div className={styles.contactFlash} style={{ opacity: flash }} /> : null}
      <LiveBug o={1} t={t} />
      <NetworkBug o={1} />
      <TimeStamp o={1} />
      <ScoreBug o={1} clock={clock} />
      <Banner k={banner} />
      <Scream p={p} />
      <CathodeRay t={t} />
    </>
  );
}

function TheReplayScene({ t, p }: SceneProps) {
  const wipe = segment(p, 0.03, 0.19, easeInOutQuart);
  const replay = p >= 0.11;
  let cam: CameraState = WIDE_CAM;
  let ball: BallState | null = null;
  let jitterX = 0;
  let draw = 0;
  let fade = 0;
  let caption = 0;
  if (replay) {
    // Frame-stepped playback: the tape judders at ~10fps instead of running smooth.
    const step = segment(p, 0.3, 0.9, easeLinear);
    const u = Math.floor(0.62 * step * 16) / 16;
    const shot = flight(u);
    const chase = Math.min(1, u * 2.6);
    cam = {
      x: lerp(600, shot.x + 14, chase),
      y: lerp(568, shot.y + 4, chase),
      z: lerp(2.3, 1.62, easeOutQuad(chase)),
    };
    ball = {
      x: shot.x,
      y: shot.y,
      s: shot.s,
      rot: shot.rot,
      laces: u > 0 ? 0.3 : 0,
      squash: 1,
      opacity: 1,
      shadow: u === 0,
    };
    draw = segment(p, 0.14, 0.24);
    fade = segment(u, 0.08, 0.2, easeLinear);
    caption = Math.min(segment(p, 0.34, 0.44), 1 - segment(p, 0.9, 0.98));
    jitterX = (noise(Math.floor(t * 11)) - 0.5) * 4;
  }
  const blink = Math.floor(t * 3) % 2 === 0;
  return (
    <>
      <WorldField t={t} cam={cam} jitterX={jitterX} ball={ball} flashK={replay ? 0.15 : 0.7}>
        {replay ? <Telestrator cx={583} cy={592} rx={30} ry={40} draw={draw} fade={fade} /> : null}
      </WorldField>
      {replay ? null : <Banner k={1} />}
      <LiveBug o={replay ? 0 : 1} t={t} />
      <NetworkBug o={1} />
      <TimeStamp o={1} />
      <ScoreBug o={1} clock="0:00" />
      {replay ? (
        <div
          className={`${styles.chip} ${styles.sloMoBug}`}
          style={{ opacity: blink ? 0.95 : 0.4 }}
        >
          <span className={styles.roundDot} />
          Super slo-mo
        </div>
      ) : null}
      <Caption o={caption} text="the laces are facing the kicker" />
      <CathodeRay t={t} heavy={replay} />
      {wipe > 0 && wipe < 1 ? (
        <div
          className={styles.wipe}
          style={{ transform: `translateX(${lerp(-165, 165, wipe)}%) rotate(-14deg)` }}
        >
          <div className={styles.wipeStack}>
            <div className={styles.wipePanel} />
            <div className={styles.wipeBand}>
              {[0, 1, 2, 3, 4].map((index) => (
                <span className={styles.wipeWord} key={index}>
                  REPLAY
                </span>
              ))}
            </div>
            <div className={styles.wipePanel} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function TheVerdictScene({ t, p }: SceneProps) {
  const grow = 1 + 0.02 * easeInOutSine(Math.min(1, p / 0.95));
  const eyebrow = segment(p, 0.06, 0.16);
  const stampIn = segment(p, 0.2, 0.24);
  const slam = segment(p, 0.2, 0.265, easeInQuad);
  const rebound = segment(p, 0.265, 0.38, easeOutBack);
  const scale = p < 0.265 ? lerp(2.6, 0.96, slam) : lerp(0.96, 1, rebound);
  const shakeK = p > 0.265 ? 1 - segment(p, 0.265, 0.36) : 0;
  const shake = (noise(Math.floor(t * 40)) - 0.5) * 6 * shakeK;
  const echo = segment(p, 0.265, 0.52, easeOutCubic);
  const sub = segment(p, 0.5, 0.62);
  const foot = segment(p, 0.68, 0.78);
  return (
    <>
      <div className={styles.caseCard} style={{ transform: `scale(${grow})` }}>
        <div className={styles.caseStack}>
          <div
            className={styles.caseEyebrow}
            style={{ opacity: eyebrow, transform: `translateY(${(1 - eyebrow) * -10}px)` }}
          >
            Case file 13 · Super Bowl XVII · Final ruling
          </div>
          <div className={styles.stampWrap}>
            {echo > 0.01 && echo < 1 ? (
              <div
                className={styles.stampEcho}
                style={{
                  opacity: (1 - echo) * 0.7,
                  transform: `rotate(-7deg) scale(${lerp(1, 1.35, echo)})`,
                }}
              />
            ) : null}
            <div
              className={styles.stamp}
              style={{
                opacity: stampIn,
                transform: `translate(${shake}px, ${-shake * 0.6}px) rotate(-7deg) scale(${Math.max(
                  scale,
                  0.001,
                )})`,
              }}
            >
              The laces were in!
            </div>
          </div>
          <div
            className={styles.caseSub}
            style={{ opacity: sub, transform: `translateY(${(1 - sub) * 8}px)` }}
          >
            Einhorn is Finkle. Finkle is Einhorn.
          </div>
        </div>
        <div className={styles.caseFoot} style={{ opacity: foot }}>
          case closed.
        </div>
      </div>
      <CathodeRay t={t} />
    </>
  );
}

// ── Playback ────────────────────────────────────────────────────────────────

const SCENE_DURATIONS = [2.6, 3.2, 3.6, 3.2, 2.8] as const;
const TOTAL_SECONDS = SCENE_DURATIONS.reduce((total, duration) => total + duration, 0);

function renderScene(elapsed: number): ReactNode {
  let remaining = elapsed;
  for (let index = 0; index < SCENE_DURATIONS.length; index += 1) {
    const duration = SCENE_DURATIONS[index] ?? 0;
    const last = index === SCENE_DURATIONS.length - 1;
    if (remaining < duration || last) {
      const t = clamp(remaining, 0, duration);
      const p = clamp(t / duration, 0, 1);
      switch (index) {
        case 0:
          return <OnAirScene t={t} p={p} />;
        case 1:
          return <TheHoldScene t={t} p={p} />;
        case 2:
          return <TheKickScene t={t} p={p} />;
        case 3:
          return <TheReplayScene t={t} p={p} />;
        default:
          return <TheVerdictScene t={t} p={p} />;
      }
    }
    remaining -= duration;
  }
  return null;
}

function stageScale(): number {
  if (typeof window === "undefined") {
    return 1;
  }
  return Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The broadcast itself: one rAF clock, every pixel a pure function of elapsed time.
 * Reduced motion skips the four moving scenes and holds the closing card instead.
 */
function FinkleBroadcast({ onEnd }: Readonly<{ onEnd: () => void }>) {
  const [reduced] = useState(prefersReducedMotion);
  const [scale, setScale] = useState(stageScale);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    function onResize() {
      setScale(stageScale());
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    // The scrollbar sits out the play, and whatever was focused gets it back afterwards.
    const clipped = styles.clipped;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (clipped) {
      document.documentElement.classList.add(clipped);
    }
    return () => {
      if (clipped) {
        document.documentElement.classList.remove(clipped);
      }
      if (previous?.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onEnd();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onEnd]);

  useEffect(() => {
    if (reduced) {
      const timer = window.setTimeout(onEnd, STATIC_CARD_MS);
      return () => window.clearTimeout(timer);
    }
    let frame = 0;
    let origin: number | null = null;
    function step(now: number) {
      origin ??= now;
      const seconds = (now - origin) / 1000;
      if (seconds >= TOTAL_SECONDS) {
        onEnd();
        return;
      }
      setElapsed(seconds);
      frame = window.requestAnimationFrame(step);
    }
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [onEnd, reduced]);

  return (
    <div className={styles.overlay} aria-hidden="true" onClick={onEnd}>
      <div className={styles.stage} style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        <div className={styles.tube}>
          {reduced ? <TheVerdictScene t={0} p={1} /> : renderScene(elapsed)}
        </div>
      </div>
    </div>
  );
}

/**
 * Pick Finkle out of the contact dialog, or triple-tap the brand mark on a phone, and the
 * broadcast cuts to the 26-yarder from Super Bowl XVII. It goes wide right. The laces were in.
 */
export function FinkleCode({ children }: Readonly<{ children: ReactNode }>) {
  const [phase, setPhase] = useState<Phase>("idle");
  const logoTaps = useRef({ count: 0, lastTap: 0 });

  const start = useCallback(() => {
    setPhase((current) => (current === "idle" ? "playing" : current));
  }, []);
  const end = useCallback(() => setPhase("idle"), []);

  useEffect(() => {
    window.addEventListener(FINKLE_KICK_EVENT, start);
    return () => window.removeEventListener(FINKLE_KICK_EVENT, start);
  }, [start]);

  useEffect(() => {
    function onLogoTap(event: PointerEvent) {
      if (
        event.pointerType !== "touch" ||
        !(event.target instanceof Element) ||
        event.target.closest(".brand-mark") === null
      ) {
        return;
      }

      const now = performance.now();
      const count =
        now - logoTaps.current.lastTap <= TAP_WINDOW_MS ? logoTaps.current.count + 1 : 1;
      logoTaps.current = { count, lastTap: now };

      if (count < 3) {
        return;
      }

      logoTaps.current = { count: 0, lastTap: 0 };
      start();
    }

    document.addEventListener("pointerup", onLogoTap, { passive: true });
    return () => document.removeEventListener("pointerup", onLogoTap);
  }, [start]);

  return (
    <>
      <div data-easter-egg="finkle-code">{children}</div>
      {phase === "playing" ? <FinkleBroadcast onEnd={end} /> : null}
      <p className="sr-only" role="status">
        {phase === "idle" ? null : "Wide right. The laces were in."}
      </p>
    </>
  );
}
