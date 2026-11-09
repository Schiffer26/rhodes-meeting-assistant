// ─────────────────────────────────────────────────────────────
// RHODES · INDUSTRIAL ENVIRONMENT  (v1.3)
//
// An original layered SVG cutaway of an observation deck aboard a
// Rhodes Island-inspired research vessel. Depth is built the way a
// real set is: blurred distant hull → glazing wall → crisp interior
// architecture → blurred foreground silhouettes → volumetric light.
//
//   D0  void gradient, sky and atmospheric falloff
//   D1  exterior: sea horizon, distant platform, cranes, masts,
//       running lights                          (blurred, slow drift)
//   D2  four-bay observation wall with deep frames, transoms,
//       sill detail and glass reflections       (crisp, parallax mid)
//   D3  interior architecture: coffered ceiling with recessed
//       strips, conduit runs, valves, bulkhead hatches, placards,
//       catwalk with railing, stair flight
//   D4  overhead gantry truss, hoist carriage, pendant lamps
//   D5  foreground: heavy columns, cable bundles, deck plating,
//       silhouetted crates and console       (blurred, parallax near)
//   D6  light: window shafts, floor pools, lamp bloom, search sweep
//   D7  haze, dust, vignette
//
// Everything is local artwork — no remote assets, no imports. The
// palette comes entirely from --env-* / theme tokens, so the same
// scene reads as a dark operational deck (TERMINAL) or a bright grey
// architectural hall (ARCHIVE).
// ─────────────────────────────────────────────────────────────
import React, { useEffect, useRef } from "react";
import { useMotionScale } from "@/hooks/store";

const W = 1600;
const H = 900;

/** Observation bays — three large windows, symmetric about the deck centre
 *  (x = 800) so the identity sits in front of glazing, not a wall pier. */
const BAYS = [
  { x: 214, lit: true },
  { x: 620, lit: true },
  { x: 1026, lit: false },
];
const BAY_W = 364;
const BAY_Y = 130;
const BAY_H = 312;

export function BackgroundEnvironment() {
  const { off, reduced } = useMotionScale();
  const still = off || reduced;
  const rootRef = useRef<HTMLDivElement>(null);

  // Subtle depth parallax on pointer move. Off when motion is reduced or off,
  // and skipped entirely for touch/coarse pointers.
  useEffect(() => {
    if (still || !rootRef.current) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    const el = rootRef.current;
    let frame = 0;
    let tx = 0;
    let ty = 0;
    const apply = () => {
      frame = 0;
      el.style.setProperty("--px", tx.toFixed(3));
      el.style.setProperty("--py", ty.toFixed(3));
    };
    const onMove = (e: PointerEvent) => {
      tx = (e.clientX / window.innerWidth - 0.5) * 2;   // −1 … 1
      ty = (e.clientY / window.innerHeight - 0.5) * 2;
      if (!frame) frame = window.requestAnimationFrame(apply);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) window.cancelAnimationFrame(frame);
      el.style.removeProperty("--px");
      el.style.removeProperty("--py");
    };
  }, [still]);

  return (
    <div className="env-root" ref={rootRef} aria-hidden="true" role="presentation">

      {/* ── D0 · void, sky, atmospheric falloff ───────────────────── */}
      <div style={{
        position: "absolute", inset: 0,
        background: `linear-gradient(180deg, var(--env-void) 0%, var(--bg-deep) 34%, var(--bg) 78%, var(--bg) 100%)`,
      }} />
      <div style={{
        position: "absolute", inset: 0,
        background: `radial-gradient(130% 78% at 50% 30%, var(--env-haze) 0%, transparent 58%)`,
      }} />

      {/* ── D1 · exterior, seen beyond the glazing (blurred) ─────── */}
      <div className="env-depth env-depth-far">
        <svg className="env-layer env-blur-far" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
          <defs>
            <linearGradient id="rhSea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: "var(--env-sea)", stopOpacity: "0.95" }} />
              <stop offset="100%" style={{ stopColor: "var(--env-void)", stopOpacity: "0.85" }} />
            </linearGradient>
            <linearGradient id="rhSky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: "var(--env-sky)", stopOpacity: "1" }} />
              <stop offset="58%" style={{ stopColor: "var(--env-sky)", stopOpacity: "0.85" }} />
              <stop offset="100%" style={{ stopColor: "var(--env-horizon)", stopOpacity: "0.9" }} />
            </linearGradient>
            <radialGradient id="rhHorizonGlow" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0%" style={{ stopColor: "var(--env-horizon)", stopOpacity: "0.55" }} />
              <stop offset="100%" style={{ stopColor: "var(--env-horizon)", stopOpacity: "0" }} />
            </radialGradient>
            <linearGradient id="rhFarFade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: "var(--env-far)", stopOpacity: "0.9" }} />
              <stop offset="100%" style={{ stopColor: "var(--env-far)", stopOpacity: "0.28" }} />
            </linearGradient>
          </defs>

          <g className="env-drift" opacity="0.9">
            {/* sky: darker at altitude, warming toward the horizon */}
            <rect x="0" y="40" width={W} height="300" style={{ fill: "url(#rhSky)" }} />
            <ellipse cx="800" cy="330" rx="700" ry="70" style={{ fill: "url(#rhHorizonGlow)" }} />
            {/* horizon glow band */}
            <rect x="0" y="318" width={W} height="18" style={{ fill: "var(--env-horizon)", opacity: "0.5" }} />
            {/* distant sea */}
            <rect x="0" y="332" width={W} height="150" style={{ fill: "url(#rhSea)", opacity: "0.55" }} />
            <g style={{ stroke: "var(--env-horizon)", strokeWidth: "1", opacity: "0.16" }}>
              {[344, 352, 362, 374, 388, 404, 422].map((y, i) => (
                <line key={y} x1={i * 24} y1={y} x2={W - i * 18} y2={y} />
              ))}
            </g>

            {/* distant platform silhouette on the horizon */}
            <g style={{ fill: "var(--env-void)", opacity: "0.9" }}>
              <rect x="860" y="268" width="240" height="64" />
              <rect x="880" y="240" width="40" height="30" />
              <rect x="960" y="228" width="26" height="42" />
              <path d="M1100 282 L1180 282 L1160 262 L1116 262 Z" />
              <rect x="700" y="292" width="120" height="40" />
            </g>

            {/* vessel masts and cranes */}
            <g style={{ fill: "var(--env-void)" }} opacity="0.92">
              <rect x="252" y="120" width="8" height="212" />
              <rect x="232" y="120" width="48" height="7" />
              <rect x="240" y="154" width="32" height="5" />
              <rect x="1338" y="96" width="10" height="240" />
              <rect x="1318" y="96" width="50" height="8" />
              <rect x="1324" y="132" width="38" height="5" />
              {/* slewing crane arm */}
              <path d="M560 250 L1010 196 L1014 208 L564 264 Z" />
              <rect x="780" y="204" width="6" height="92" />
              <rect x="772" y="296" width="22" height="12" />
              <path d="M1440 300 L1560 300 L1540 276 L1460 276 Z" />
            </g>

            {/* running lights */}
            <g style={{ fill: "var(--env-warm)" }}>
              <circle cx="1343" cy="92" r="4" className={still ? undefined : "env-beacon"} />
              <circle cx="256" cy="116" r="3.2" className={still ? undefined : "env-beacon"} />
              <circle cx="1486" cy="272" r="3" className={still ? undefined : "env-beacon"} />
            </g>
            <g style={{ fill: "var(--env-warm)" }} opacity="0.55">
              {[[876, 286], [886, 286], [906, 300], [936, 286], [946, 300], [976, 286], [1010, 290], [1044, 302], [1064, 286]].map(([x, y]) => (
                <rect key={`w${x}-${y}`} x={x} y={y} width="4" height="3" />
              ))}
            </g>
            <g style={{ fill: "var(--env-cyan)" }} opacity="0.7">
              {[[612, 236], [742, 232], [902, 244], [1044, 232], [1190, 246], [1290, 262]].map(([x, y]) => (
                <circle key={`${x}-${y}`} cx={x} cy={y} r="2.2" />
              ))}
            </g>
          </g>
        </svg>
      </div>

      {/* ── D2 · observation wall (crisp) ────────────────────────── */}
      <div className="env-depth env-depth-mid">
        <svg className="env-layer" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
          <defs>
            {/* tinted glazing: transmits the exterior, darkens toward the head */}
            <linearGradient id="rhGlass" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: "var(--env-void)", stopOpacity: "0.62" }} />
              <stop offset="38%" style={{ stopColor: "var(--env-sky)", stopOpacity: "0.3" }} />
              <stop offset="64%" style={{ stopColor: "var(--env-sky)", stopOpacity: "0.16" }} />
              <stop offset="100%" style={{ stopColor: "var(--env-void)", stopOpacity: "0.42" }} />
            </linearGradient>
            <linearGradient id="rhSheen" x1="0" y1="0" x2="0.7" y2="1">
              <stop offset="0%" style={{ stopColor: "var(--env-white)", stopOpacity: "0.1" }} />
              <stop offset="45%" style={{ stopColor: "var(--env-white)", stopOpacity: "0.025" }} />
              <stop offset="100%" style={{ stopColor: "var(--env-white)", stopOpacity: "0" }} />
            </linearGradient>
            {/* wall with the observation bays cut out of it */}
            <mask id="rhBays">
              <rect x="0" y={BAY_Y - 30} width={W} height={BAY_H + 68} fill="#fff" />
              {BAYS.map((b, i) => (
                <rect key={i} x={b.x} y={BAY_Y} width={BAY_W} height={BAY_H} fill="#000" />
              ))}
            </mask>
            <linearGradient id="rhFrame" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: "var(--env-beam-hi)" }} />
              <stop offset="100%" style={{ stopColor: "var(--env-beam)" }} />
            </linearGradient>
          </defs>

          {/* structural wall, pierced by the observation bays */}
          <g mask="url(#rhBays)">
            <rect x="0" y={BAY_Y - 30} width={W} height={BAY_H + 68} style={{ fill: "var(--env-mid)" }} />
            <g style={{ fill: "var(--env-line)" }} opacity="0.5">
              {Array.from({ length: 9 }, (_, i) => (
                <rect key={i} x={i * 200} y={BAY_Y - 30} width="2" height={BAY_H + 68} />
              ))}
            </g>
            <rect x="0" y={BAY_Y - 30} width={W} height="6" style={{ fill: "var(--env-beam)", opacity: "0.8" }} />
          </g>
          {/* recessed window reveal */}
          <rect x="0" y={BAY_Y - 26} width={W} height="26" style={{ fill: "var(--env-near)", opacity: "0.9" }} />
          <rect x="0" y={BAY_Y + BAY_H} width={W} height="30" style={{ fill: "var(--env-near)", opacity: "0.92" }} />

          {BAYS.map((b, i) => {
            const x = b.x;
            return (
              <g key={i}>
                {/* glazing */}
                <rect x={x} y={BAY_Y} width={BAY_W} height={BAY_H} style={{ fill: "url(#rhGlass)" }} />
                {/* interior reflected sheen */}
                <rect x={x} y={BAY_Y} width={BAY_W} height={BAY_H} style={{ fill: "url(#rhSheen)" }} />
                {/* horizon inside the glass */}
                <rect x={x} y={BAY_Y + BAY_H * 0.64} width={BAY_W} height="1" style={{ fill: "var(--env-cyan)", opacity: "0.26" }} />

                {/* mullions: one centre upright + two transoms */}
                <rect x={x + BAY_W / 2 - 3} y={BAY_Y} width="6" height={BAY_H} style={{ fill: "var(--env-beam)" }} />
                <rect x={x} y={BAY_Y + BAY_H * 0.36} width={BAY_W} height="5" style={{ fill: "var(--env-beam)" }} />
                <rect x={x} y={BAY_Y + BAY_H * 0.72} width={BAY_W} height="4" style={{ fill: "var(--env-beam)" }} />

                {/* deep welded frame */}
                <rect x={x - 12} y={BAY_Y - 12} width={BAY_W + 24} height="12" style={{ fill: "url(#rhFrame)" }} />
                <rect x={x - 12} y={BAY_Y - 12} width="12" height={BAY_H + 24} style={{ fill: "url(#rhFrame)" }} />
                <rect x={x + BAY_W} y={BAY_Y - 12} width="12" height={BAY_H + 24} style={{ fill: "url(#rhFrame)" }} />
                {/* bolt line along the frame head */}
                <g style={{ fill: "var(--env-rivet)" }} opacity="0.55">
                  {Array.from({ length: 9 }, (_, k) => (
                    <circle key={k} cx={x + 16 + k * 38} cy={BAY_Y - 6} r="1.6" />
                  ))}
                </g>
                {/* sill with a lit nosing */}
                <rect x={x - 16} y={BAY_Y + BAY_H + 2} width={BAY_W + 32} height="12" style={{ fill: "var(--env-beam-hi)" }} />
                <rect x={x - 16} y={BAY_Y + BAY_H + 14} width={BAY_W + 32} height="5" style={{ fill: "var(--env-near)" }} />
                {b.lit && (
                  <rect x={x - 16} y={BAY_Y + BAY_H + 12} width={BAY_W + 32} height="2"
                    style={{ fill: "var(--env-cyan)", opacity: "0.75" }} className={still ? undefined : "env-flicker"} />
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* ── D3/D4 · interior architecture ────────────────────────── */}
      <svg className="env-layer" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="rhBeam" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--env-beam-hi)" }} />
            <stop offset="100%" style={{ stopColor: "var(--env-beam)" }} />
          </linearGradient>
          <linearGradient id="rhPipe" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--env-beam-hi)" }} />
            <stop offset="42%" style={{ stopColor: "var(--env-beam)" }} />
            <stop offset="100%" style={{ stopColor: "var(--env-near)" }} />
          </linearGradient>
          <pattern id="rhDeck" width="30" height="30" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="30" style={{ stroke: "var(--env-line)", strokeWidth: "6" }} />
          </pattern>
        </defs>

        {/* coffered ceiling */}
        <rect x="0" y="0" width={W} height="86" style={{ fill: "var(--env-near)", opacity: "0.95" }} />
        <g style={{ fill: "var(--env-beam)" }}>
          {Array.from({ length: 9 }, (_, i) => (
            <rect key={i} x={i * 190} y="0" width="18" height="86" opacity="0.85" />
          ))}
        </g>
        {/* recessed light strips */}
        <g>
          {[74, 264, 454, 644, 834, 1024, 1214, 1404].map((x) => (
            <g key={x}>
              <rect x={x} y="46" width="112" height="7" rx="0" style={{ fill: "var(--env-white)", opacity: "0.5" }} />
              <rect x={x} y="43" width="112" height="3" style={{ fill: "var(--env-beam-hi)" }} />
            </g>
          ))}
        </g>
        {/* gantry truss across the ceiling */}
        <g style={{ fill: "url(#rhBeam)" }}>
          <path d="M-40 100 L1640 66 L1640 100 L-40 134 Z" opacity="0.95" />
        </g>
        <g style={{ stroke: "var(--env-beam-hi)", strokeWidth: "5", fill: "none", opacity: "0.55" }}>
          {Array.from({ length: 15 }, (_, i) => {
            const x = -20 + i * 112;
            return <path key={i} d={`M${x} 132 L${x + 56} 112 L${x + 112} 96`} />;
          })}
        </g>

        {/* upper wall plating + seams */}
        <rect x="0" y="134" width={W} height="4" style={{ fill: "var(--env-line)", opacity: "0.7" }} />
        <g style={{ fill: "var(--env-line)" }} opacity="0.5">
          {Array.from({ length: 7 }, (_, i) => (
            <rect key={i} x={i * 240} y="138" width="2" height="26" />
          ))}
        </g>

        {/* conduit runs with valves and junction boxes */}
        <g>
          <rect x="0" y="96" width={W} height="16" style={{ fill: "url(#rhPipe)", opacity: "0.92" }} />
          <rect x="0" y="116" width={W} height="8" style={{ fill: "url(#rhPipe)", opacity: "0.82" }} />
          <g style={{ fill: "var(--env-near)" }} opacity="0.95">
            {[186, 498, 760, 1062, 1372].map((x) => (
              <rect key={x} x={x} y="90" width="16" height="40" />
            ))}
          </g>
          {/* valve wheels */}
          <g style={{ stroke: "var(--env-rivet)", strokeWidth: "2", fill: "none", opacity: "0.65" }}>
            {[194, 506, 768, 1070, 1380].map((x) => (
              <g key={x}>
                <circle cx={x + 8} cy="132" r="9" />
                <line x1={x - 2} y1="132" x2={x + 18} y2="132" />
                <line x1={x + 8} y1="122" x2={x + 8} y2="142" />
              </g>
            ))}
          </g>
        </g>

        {/* bulkhead below the glazing: access hatches + placards */}
        <rect x="0" y={BAY_Y + BAY_H + 30} width={W} height="60" style={{ fill: "var(--env-mid)", opacity: "0.5" }} />
        <g style={{ fill: "var(--env-near)" }} opacity="0.9">
          <rect x="96" y="480" width="128" height="52" />
          <rect x="700" y="482" width="150" height="48" />
          <rect x="1240" y="478" width="118" height="54" />
        </g>
        <g style={{ fill: "var(--env-rivet)" }} opacity="0.45">
          <rect x="110" y="492" width="70" height="6" />
          <rect x="110" y="504" width="44" height="6" />
          <rect x="714" y="494" width="86" height="6" />
          <rect x="1254" y="490" width="58" height="6" />
        </g>
        {/* safety placards — the only saturated paint on the wall */}
        <g>
          <rect x="262" y="492" width="34" height="22" style={{ fill: "var(--env-warm)", opacity: "0.55" }} />
          <rect x="980" y="496" width="30" height="20" style={{ fill: "var(--env-cyan)", opacity: "0.4" }} />
        </g>

        {/* catwalk with railing and stair */}
        <g style={{ fill: "var(--env-near)" }} opacity="0.9">
          <rect x="0" y="556" width={W} height="14" />
          <rect x="0" y="570" width={W} height="6" opacity="0.8" />
        </g>
        <g style={{ fill: "var(--env-beam-hi)" }} opacity="0.55">
          {Array.from({ length: 12 }, (_, i) => (
            <rect key={i} x={60 + i * 132} y="520" width="4" height="36" />
          ))}
          <rect x="0" y="518" width={W} height="3" />
          <rect x="0" y="536" width={W} height="2" opacity="0.7" />
        </g>
        {/* stair flight down to the deck */}
        <g style={{ fill: "var(--env-beam)", opacity: "0.8" }}>
          {Array.from({ length: 7 }, (_, i) => (
            <rect key={i} x={1180 + i * 26} y={590 + i * 30} width="92" height="9" />
          ))}
        </g>

        {/* pendant service lamps */}
        {[236, 612, 1044, 1392].map((x, i) => {
          const top = 188 + i * 10;
          return (
            <g key={`lamp-${x}`}>
              {/* drop rod and ceiling plate */}
              <rect x={x - 1.5} y="134" width="3" height={top - 152} style={{ fill: "var(--env-rivet)" }} opacity="0.75" />
              <rect x={x - 8} y="132" width="16" height="4" style={{ fill: "var(--env-beam-hi)" }} opacity="0.8" />
              {/* metal shade */}
              <path d={`M${x - 20} ${top} L${x + 20} ${top} L${x + 13} ${top + 16} L${x - 13} ${top + 16} Z`}
                style={{ fill: "var(--env-beam-hi)" }} opacity="0.9" />
              <path d={`M${x - 20} ${top} L${x + 20} ${top} L${x + 19} ${top + 3} L${x - 19} ${top + 3} Z`}
                style={{ fill: "var(--env-near)" }} opacity="0.8" />
              {/* emissive mouth */}
              <rect x={x - 13} y={top + 16} width="26" height="2.5" style={{ fill: "var(--env-warm)" }} opacity="0.85"
                className={still ? undefined : "env-flicker"} />
            </g>
          );
        })}

        {/* hoist carriage riding the truss */}
        <g style={{ fill: "var(--env-near)" }}>
          <rect x="668" y="100" width="132" height="9" opacity="0.9" />
          <rect x="694" y="109" width="80" height="24" />
          <rect x="694" y="109" width="80" height="3.5" style={{ fill: "var(--env-beam-hi)" }} />
          <rect x="730" y="133" width="5" height="38" style={{ fill: "var(--env-beam)" }} />
          <path d="M718 171 L747 171 L741 182 L724 182 Z" />
          <rect x="668" y="100" width="13" height="16" opacity="0.8" />
          <rect x="787" y="100" width="13" height="16" opacity="0.8" />
        </g>
        <circle cx="734" cy="104" r="2.6" style={{ fill: "var(--env-warm)" }} opacity="0.6" className={still ? undefined : "env-beacon"} />
      </svg>

      {/* ── D5 · foreground: columns, cables, deck, silhouettes ──── */}
      <div className="env-depth env-depth-near">
        <svg className="env-layer env-blur-near" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
          <defs>
            <linearGradient id="rhCol" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" style={{ stopColor: "var(--env-void)" }} />
              <stop offset="55%" style={{ stopColor: "var(--env-near)" }} />
              <stop offset="100%" style={{ stopColor: "var(--env-void)" }} />
            </linearGradient>
            <linearGradient id="rhRim" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: "var(--env-cyan)", stopOpacity: "0.5" }} />
              <stop offset="55%" style={{ stopColor: "var(--env-cyan)", stopOpacity: "0.1" }} />
              <stop offset="100%" style={{ stopColor: "var(--env-cyan)", stopOpacity: "0" }} />
            </linearGradient>
          </defs>

          {/* deck plating in perspective */}
          <rect x="0" y="700" width={W} height="200" style={{ fill: "var(--env-near)" }} />
          <rect x="0" y="700" width={W} height="200" style={{ fill: "url(#rhDeck)", opacity: "0.26" }} />
          <g style={{ stroke: "var(--env-line)", strokeWidth: "1.5", opacity: "0.4" }}>
            {Array.from({ length: 9 }, (_, i) => (
              <line key={i} x1={-200 + i * 250} y1="700" x2={-460 + i * 330} y2="900" />
            ))}
          </g>
          <rect x="0" y="698" width={W} height="3" style={{ fill: "var(--env-line)", opacity: "0.75" }} />

          {/* heavy columns */}
          <g style={{ fill: "url(#rhCol)" }}>
            <rect x="-24" y="-20" width="118" height="760" />
            <rect x="94" y="-20" width="10" height="760" opacity="0.7" />
            <rect x="1512" y="-20" width="112" height="760" />
            <rect x="1500" y="-20" width="10" height="760" opacity="0.7" />
          </g>
          {/* rim light down the inner edges */}
          <rect x="94" y="0" width="3" height="720" style={{ fill: "url(#rhRim)" }} />
          <rect x="1503" y="0" width="3" height="720" style={{ fill: "url(#rhRim)" }} />
          {/* column flanges + bolts */}
          <g style={{ fill: "var(--env-void)" }} opacity="0.85">
            <rect x="-24" y="286" width="128" height="16" />
            <rect x="-24" y="600" width="128" height="20" />
            <rect x="1504" y="272" width="120" height="16" />
            <rect x="1500" y="596" width="124" height="20" />
          </g>
          <g style={{ fill: "var(--env-rivet)" }} opacity="0.4">
            {Array.from({ length: 6 }, (_, i) => (
              <circle key={i} cx={-6 + i * 22} cy="294" r="2" />
            ))}
            {Array.from({ length: 5 }, (_, i) => (
              <circle key={`r${i}`} cx={1518 + i * 22} cy="280" r="2" />
            ))}
          </g>

          {/* cable bundles hanging into frame */}
          <g style={{ fill: "var(--env-void)" }} opacity="0.95">
            <path d="M148 0 C142 110 154 190 142 300 L154 300 C166 190 152 110 158 0 Z" />
            <path d="M168 0 C174 86 164 158 174 232 L184 232 C178 158 188 86 182 0 Z" opacity="0.85" />
            <path d="M1448 0 C1442 128 1454 208 1442 318 L1454 318 C1466 208 1452 128 1458 0 Z" />
            <path d="M1470 0 C1474 78 1464 152 1474 214 L1482 214 C1476 152 1486 78 1480 0 Z" opacity="0.85" />
          </g>

          {/* silhouetted equipment at the deck edge */}
          <g style={{ fill: "var(--env-void)" }} opacity="0.9">
            <rect x="124" y="716" width="104" height="122" />
            <rect x="140" y="700" width="72" height="18" />
            <rect x="1360" y="700" width="132" height="140" />
            <rect x="1382" y="682" width="88" height="20" />
            <path d="M1382 682 L1470 682 L1450 660 L1402 660 Z" opacity="0.7" />
          </g>
          <g style={{ fill: "var(--env-cyan)" }} opacity="0.35">
            <rect x="140" y="742" width="12" height="3" />
            <rect x="1382" y="726" width="16" height="3" />
          </g>
        </svg>
      </div>

      {/* ── D6 · light: shafts, pools, bloom, sweep ──────────────── */}
      <svg className="env-layer" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="rhShaft" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--env-white)", stopOpacity: "0.16" }} />
            <stop offset="70%" style={{ stopColor: "var(--env-white)", stopOpacity: "0.04" }} />
            <stop offset="100%" style={{ stopColor: "var(--env-white)", stopOpacity: "0" }} />
          </linearGradient>
          <radialGradient id="rhPool" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" style={{ stopColor: "var(--env-cyan)", stopOpacity: "0.22" }} />
            <stop offset="100%" style={{ stopColor: "var(--env-cyan)", stopOpacity: "0" }} />
          </radialGradient>
          <radialGradient id="rhBloomWarm" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" style={{ stopColor: "var(--env-warm)", stopOpacity: "0.26" }} />
            <stop offset="100%" style={{ stopColor: "var(--env-warm)", stopOpacity: "0" }} />
          </radialGradient>
          <linearGradient id="rhSweep" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--env-white)", stopOpacity: "0.14" }} />
            <stop offset="100%" style={{ stopColor: "var(--env-white)", stopOpacity: "0" }} />
          </linearGradient>
        </defs>

        {/* light shafts falling from each glazing bay */}
        {BAYS.map((b, i) => (
          <g key={`shaft-${i}`}>
            <path
              d={`M${b.x + 10} ${BAY_Y + BAY_H} L${b.x + BAY_W - 10} ${BAY_Y + BAY_H} L${b.x + BAY_W + 120} 900 L${b.x - 130} 900 Z`}
              style={{ fill: "url(#rhShaft)" }} opacity={b.lit ? 0.9 : 0.45} />
            <ellipse cx={b.x + BAY_W / 2} cy="806" rx="260" ry="86" style={{ fill: "url(#rhPool)" }} opacity={b.lit ? 1.35 : 0.6} />
          </g>
        ))}

        {/* warm pools beneath the pendant lamps */}
        {[236, 612, 1044, 1392].map((x, i) => (
          <ellipse key={`warm-${x}`} cx={x} cy={252 + i * 10} rx="130" ry="96" style={{ fill: "url(#rhBloomWarm)" }} />
        ))}

        {/* slow search-light sweep */}
        <g className={still ? undefined : "env-sweep"}>
          <path d="M120 0 L330 0 L700 900 L250 900 Z" style={{ fill: "url(#rhSweep)" }} opacity="0.35" />
        </g>
      </svg>

      {/* ── D7 · atmosphere ──────────────────────────────────────── */}
      <div className={still ? undefined : "env-haze"} style={{
        position: "absolute", inset: 0,
        background: `linear-gradient(180deg, transparent 34%, var(--env-haze) 60%, transparent 100%)`,
      }} />
      <div style={{
        position: "absolute", inset: 0,
        background: `radial-gradient(118% 86% at 50% 38%, transparent 40%, var(--env-shade) 100%)`,
      }} />
      <div style={{
        position: "absolute", inset: 0,
        background: `linear-gradient(180deg, var(--bg-deep) 0%, transparent 12%, transparent 84%, var(--bg) 100%)`,
        opacity: "0.5",
      }} />
    </div>
  );
}
