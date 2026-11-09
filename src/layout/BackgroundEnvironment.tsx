// ─────────────────────────────────────────────────────────────
// RHODES · INDUSTRIAL ENVIRONMENT
//
// A layered, original SVG composition standing in for the
// operations deck of a Rhodes Island-inspired research vessel:
//
//   L0  void gradient + atmospheric depth
//   L1  distant vessel structures, masts and aircraft beacons
//   L2  observation glazing band (the room's main light source)
//   L3  bulkhead walls, ribbed plating, conduits, machinery
//   L4  overhead gantry truss + catwalk
//   L5  foreground columns, cable bundles, deck grating
//   L6  volumetric light, bloom and a slow search-light sweep
//   L7  haze, dust and vignette
//
// Everything is local artwork — no remote assets, no imports.
// Palette is driven by CSS variables so the same scene renders
// as a dark industrial deck (TERMINAL) or a bright grey
// architectural environment (ARCHIVE).
// ─────────────────────────────────────────────────────────────
import React from "react";
import { useMotionScale } from "@/hooks/store";

const W = 1600;
const H = 900;

/** Window band geometry — the room's dominant light source. */
const WINDOWS = Array.from({ length: 8 }, (_, i) => ({
  x: 52 + i * 190,
  w: 168,
  lit: i !== 2 && i !== 5,
}));

export function BackgroundEnvironment() {
  const { off, reduced } = useMotionScale();
  const still = off || reduced;

  return (
    <div className="env-root" aria-hidden="true" role="presentation">
      {/* ── L0 · void gradient + depth ─────────────────────────────── */}
      <div style={{
        position: "absolute", inset: 0,
        background: `linear-gradient(180deg, var(--env-void) 0%, var(--bg-deep) 42%, var(--bg) 100%)`,
      }} />
      <div style={{
        position: "absolute", inset: 0,
        background: `radial-gradient(120% 70% at 50% 34%, var(--env-haze) 0%, transparent 62%)`,
      }} />

      {/* ── L1 · distant structures ────────────────────────────────── */}
      <svg className="env-layer" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="rhFarFade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--env-far)", stopOpacity: "0.95" }} />
            <stop offset="100%" style={{ stopColor: "var(--env-far)", stopOpacity: "0.35" }} />
          </linearGradient>
          <linearGradient id="rhSkyGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--env-sky)", stopOpacity: "1" }} />
            <stop offset="100%" style={{ stopColor: "var(--env-void)", stopOpacity: "0.9" }} />
          </linearGradient>
        </defs>

        <g className={still ? undefined : "env-drift"} opacity="0.85">
          {/* far hull silhouette */}
          <path d="M0 470 L220 430 L360 442 L520 420 L760 436 L980 418 L1220 438 L1440 424 L1600 448 L1600 560 L0 560 Z"
            style={{ fill: "url(#rhFarFade)" }} />
          {/* masts */}
          <g style={{ fill: "var(--env-far)" }}>
            <rect x="268" y="236" width="9" height="210" />
            <rect x="252" y="236" width="41" height="7" />
            <rect x="258" y="268" width="30" height="5" />
            <rect x="1030" y="196" width="11" height="250" />
            <rect x="1012" y="196" width="47" height="8" />
            <rect x="1018" y="232" width="35" height="5" />
            <rect x="1394" y="258" width="8" height="190" />
            <rect x="1380" y="258" width="36" height="6" />
            <path d="M1340 452 L1470 452 L1448 430 L1362 430 Z" />
            <rect x="470" y="300" width="7" height="146" />
            <rect x="458" y="300" width="31" height="6" />
            {/* crane arm */}
            <path d="M700 300 L1180 250 L1184 262 L706 314 Z" />
            <rect x="940" y="262" width="6" height="96" />
          </g>
          {/* aircraft warning beacons on distant masts */}
          <g style={{ fill: "var(--env-warm)" }}>
            <circle cx="1035" cy="192" r="4" className={still ? undefined : "env-beacon"} />
            <circle cx="1400" cy="254" r="3.2" className={still ? undefined : "env-beacon"} />
            <circle cx="272" cy="232" r="3" className={still ? undefined : "env-beacon"} />
          </g>
          {/* distant cool marker lights */}
          <g style={{ fill: "var(--env-cyan)" }} opacity="0.75">
            <circle cx="600" cy="352" r="2.4" />
            <circle cx="820" cy="338" r="2.4" />
            <circle cx="1180" cy="322" r="2.4" />
            <circle cx="1290" cy="352" r="2.4" />
          </g>
        </g>

        {/* ── L2 · observation glazing band ────────────────────────── */}
        <g>
          {WINDOWS.map((w, i) => (
            <g key={i}>
              <rect x={w.x} y="214" width={w.w} height="196" style={{ fill: "url(#rhSkyGrad)" }} />
              {/* horizon / distant sea inside the glazing */}
              <rect x={w.x} y="356" width={w.w} height="54" style={{ fill: "var(--env-void)", opacity: "0.5" }} />
              {/* lit horizon line + sea sheen */}
              <rect x={w.x} y="344" width={w.w} height="12" style={{ fill: "var(--env-cyan)", opacity: "0.12" }} />
              <rect x={w.x} y="354" width={w.w} height="2" style={{ fill: "var(--env-cyan)", opacity: "0.72" }} />
              <rect x={w.x} y="360" width={w.w} height="1" style={{ fill: "var(--env-cyan)", opacity: "0.28" }} />
              <rect x={w.x} y="368" width={w.w} height="1" style={{ fill: "var(--env-cyan)", opacity: "0.18" }} />
              {w.lit && (
                <g opacity="0.5" style={{ fill: "var(--env-far)" }}>
                  <rect x={w.x + 22} y="330" width="12" height="26" />
                  <rect x={w.x + 120} y="316" width="9" height="40" />
                  <rect x={w.x + 40} y="344" width="70" height="12" />
                </g>
              )}
              {/* mullions */}
              <rect x={w.x + w.w / 2 - 2.5} y="214" width="5" height="196" style={{ fill: "var(--env-beam)" }} />
              <rect x={w.x} y="306" width={w.w} height="5" style={{ fill: "var(--env-beam)" }} />
              {/* frame */}
              <rect x={w.x - 6} y="206" width={w.w + 12} height="8" style={{ fill: "var(--env-beam-hi)" }} />
              <rect x={w.x - 6} y="406" width={w.w + 12} height="14" style={{ fill: "var(--env-beam)" }} />
              {/* sill glow */}
              {w.lit && (
                <rect x={w.x - 6} y="404" width={w.w + 12} height="2.5"
                  style={{ fill: "var(--env-cyan)", opacity: "0.8" }} className={still ? undefined : "env-flicker"} />
              )}
            </g>
          ))}
        </g>
      </svg>

      {/* ── L3 · bulkhead, conduits, machinery ────────────────────── */}
      <svg className="env-layer" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="rhBeam" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--env-beam-hi)" }} />
            <stop offset="100%" style={{ stopColor: "var(--env-beam)" }} />
          </linearGradient>
          <linearGradient id="rhPipe" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--env-beam-hi)" }} />
            <stop offset="45%" style={{ stopColor: "var(--env-beam)" }} />
            <stop offset="100%" style={{ stopColor: "var(--env-near)" }} />
          </linearGradient>
          <pattern id="rhGrate" width="26" height="26" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="26" height="26" style={{ fill: "transparent" }} />
            <line x1="0" y1="0" x2="0" y2="26" style={{ stroke: "var(--env-line)", strokeWidth: "5" }} />
          </pattern>
        </defs>

        {/* wall plating behind the glazing */}
        <rect x="0" y="0" width={W} height="470" style={{ fill: "var(--env-mid)", opacity: "0.55" }} />
        <rect x="0" y="420" width={W} height="480" style={{ fill: "var(--env-mid)", opacity: "0.35" }} />

        {/* vertical structural ribs */}
        <g style={{ fill: "url(#rhBeam)" }}>
          {Array.from({ length: 13 }, (_, i) => (
            <rect key={i} x={40 + i * 124} y="0" width="16" height="470" opacity="0.55" />
          ))}
        </g>
        {/* horizontal seams */}
        <g style={{ fill: "var(--env-line)" }}>
          <rect x="0" y="466" width={W} height="3" opacity="0.8" />
          <rect x="0" y="560" width={W} height="2" opacity="0.55" />
          <rect x="0" y="672" width={W} height="2" opacity="0.45" />
          <rect x="0" y="762" width={W} height="3" opacity="0.5" />
        </g>
        {/* rivet rows */}
        <g style={{ fill: "var(--env-rivet)" }} opacity="0.6">
          {Array.from({ length: 40 }, (_, i) => (
            <circle key={i} cx={30 + i * 40} cy="474" r="1.7" />
          ))}
          {Array.from({ length: 40 }, (_, i) => (
            <circle key={`b${i}`} cx={50 + i * 40} cy="770" r="1.5" />
          ))}
        </g>

        {/* ceiling conduit runs */}
        <g>
          <rect x="0" y="44" width={W} height="22" style={{ fill: "url(#rhPipe)", opacity: "0.9" }} />
          <rect x="0" y="76" width={W} height="11" style={{ fill: "url(#rhPipe)", opacity: "0.8" }} />
          <rect x="0" y="98" width={W} height="7" style={{ fill: "var(--env-near)", opacity: "0.85" }} />
          <g style={{ fill: "var(--env-near)" }} opacity="0.9">
            {[160, 420, 690, 960, 1230, 1460].map((x) => (
              <rect key={x} x={x} y="36" width="14" height="72" />
            ))}
          </g>
        </g>

        {/* machinery silhouettes on the flanks */}
        <g style={{ fill: "var(--env-near)" }} opacity="0.9">
          <rect x="18" y="500" width="150" height="210" />
          <rect x="34" y="474" width="118" height="30" />
          <rect x="1428" y="486" width="160" height="236" />
          <rect x="1446" y="456" width="124" height="34" />
          <rect x="144" y="546" width="86" height="120" />
        </g>
        <g style={{ fill: "var(--env-rivet)" }} opacity="0.5">
          <rect x="34" y="520" width="42" height="8" />
          <rect x="34" y="540" width="70" height="8" />
          <rect x="1444" y="512" width="52" height="8" />
          <rect x="1444" y="534" width="92" height="8" />
        </g>
        {/* machinery status lamps */}
        <g>
          <circle cx="50" cy="500" r="4" style={{ fill: "var(--env-cyan)" }} className={still ? undefined : "env-flicker"} />
          <circle cx="1460" cy="492" r="4" style={{ fill: "var(--env-warm)" }} className={still ? undefined : "env-beacon"} />
        </g>

        {/* ── L4 · overhead gantry truss + catwalk ─────────────────── */}
        <g style={{ fill: "url(#rhBeam)" }}>
          <path d="M-40 118 L1640 40 L1640 84 L-40 162 Z" opacity="0.95" />
          <path d="M-40 214 L1640 136 L1640 168 L-40 246 Z" opacity="0.8" />
        </g>
        <g style={{ stroke: "var(--env-beam-hi)", strokeWidth: "6", fill: "none", opacity: "0.7" }}>
          {Array.from({ length: 15 }, (_, i) => {
            const x = 10 + i * 108;
            return <path key={i} d={`M${x} 162 L${x + 108} 120 M${x + 108} 120 L${x} 78`} />;
          })}
        </g>
        {/* catwalk railing */}
        <g style={{ fill: "var(--env-near)" }} opacity="0.85">
          <rect x="0" y="196" width={W} height="6" />
          {[120, 300, 480, 660, 840, 1020, 1200, 1380].map((x) => (
            <rect key={x} x={x} y="164" width="5" height="34" />
          ))}
        </g>
        {/* pendant service lamps */}
        <g>
          {[236, 612, 1044, 1392].map((x, i) => (
            <g key={x}>
              <rect x={x - 1.5} y="168" width="3" height={56 + i * 14} style={{ fill: "var(--env-beam-hi)" }} opacity="0.7" />
              <path d={`M${x - 17} ${224 + i * 14} L${x + 17} ${224 + i * 14} L${x + 11} ${240 + i * 14} L${x - 11} ${240 + i * 14} Z`}
                style={{ fill: "var(--env-warm)" }} opacity="0.5" />
              <path d={`M${x - 17} ${224 + i * 14} L${x + 17} ${224 + i * 14} L${x + 11} ${240 + i * 14} L${x - 11} ${240 + i * 14} Z`}
                style={{ fill: "var(--env-warm)" }} opacity="0.35" className={still ? undefined : "env-flicker"} />
            </g>
          ))}
        </g>
        {/* hoist trolley — reads as a gantry carriage, not a floating block */}
        <g style={{ fill: "var(--env-near)" }}>
          <rect x="676" y="84" width="126" height="10" opacity="0.9" />
          <rect x="700" y="94" width="78" height="26" />
          <rect x="700" y="94" width="78" height="4" style={{ fill: "var(--env-beam-hi)" }} />
          <rect x="734" y="120" width="5" height="42" style={{ fill: "var(--env-beam)" }} />
          <path d="M722 162 L752 162 L746 174 L728 174 Z" />
          <rect x="676" y="84" width="14" height="18" opacity="0.8" />
          <rect x="788" y="84" width="14" height="18" opacity="0.8" />
        </g>
        <circle cx="738" cy="88" r="3" style={{ fill: "var(--env-warm)" }} opacity="0.55" className={still ? undefined : "env-beacon"} />
      </svg>

      {/* ── L5 · foreground columns, cables, deck ─────────────────── */}
      <svg className={`env-layer${still ? "" : " env-parallax"}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="rhCol" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" style={{ stopColor: "var(--env-near)" }} />
            <stop offset="55%" style={{ stopColor: "var(--env-beam)" }} />
            <stop offset="100%" style={{ stopColor: "var(--env-near)" }} />
          </linearGradient>
        </defs>

        {/* deck plating */}
        <rect x="0" y="770" width={W} height="130" style={{ fill: "var(--env-near)", opacity: "0.9" }} />
        <rect x="0" y="770" width={W} height="130" style={{ fill: "url(#rhGrate)", opacity: "0.28" }} />
        <rect x="0" y="768" width={W} height="4" style={{ fill: "var(--env-line)", opacity: "0.8" }} />

        {/* heavy foreground columns */}
        <g style={{ fill: "url(#rhCol)" }}>
          <rect x="-10" y="-10" width="96" height="800" />
          <rect x="86" y="-10" width="14" height="800" opacity="0.6" />
          <rect x="1520" y="-10" width="90" height="800" />
          <rect x="1512" y="-10" width="10" height="800" opacity="0.6" />
        </g>
        <g style={{ fill: "var(--env-line)" }} opacity="0.65">
          <rect x="0" y="300" width="98" height="10" />
          <rect x="0" y="612" width="98" height="14" />
          <rect x="1508" y="286" width="92" height="10" />
          <rect x="1504" y="606" width="96" height="14" />
        </g>

        {/* hanging cable bundles */}
        <g style={{ fill: "var(--env-near)" }} opacity="0.9">
          <path d="M300 0 C296 120 306 210 296 330 L306 330 C316 210 306 120 310 0 Z" />
          <path d="M318 0 C322 100 314 190 322 268 L330 268 C324 190 332 100 328 0 Z" opacity="0.8" />
          <path d="M1290 0 C1284 140 1294 230 1284 360 L1296 360 C1306 230 1294 140 1300 0 Z" />
          <path d="M1310 0 C1314 90 1306 170 1314 240 L1322 240 C1316 170 1324 90 1320 0 Z" opacity="0.8" />
        </g>
      </svg>

      {/* ── L6 · volumetric light ──────────────────────────────────── */}
      <svg className="env-layer" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          <radialGradient id="rhBloomCyan" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" style={{ stopColor: "var(--env-cyan)", stopOpacity: "0.4" }} />
            <stop offset="60%" style={{ stopColor: "var(--env-cyan)", stopOpacity: "0.08" }} />
            <stop offset="100%" style={{ stopColor: "var(--env-cyan)", stopOpacity: "0" }} />
          </radialGradient>
          <radialGradient id="rhBloomWarm" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" style={{ stopColor: "var(--env-warm)", stopOpacity: "0.3" }} />
            <stop offset="65%" style={{ stopColor: "var(--env-warm)", stopOpacity: "0.05" }} />
            <stop offset="100%" style={{ stopColor: "var(--env-warm)", stopOpacity: "0" }} />
          </radialGradient>
          <linearGradient id="rhBeamCone" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--env-white)", stopOpacity: "0.22" }} />
            <stop offset="100%" style={{ stopColor: "var(--env-white)", stopOpacity: "0" }} />
          </linearGradient>
        </defs>

        {/* glazing bloom */}
        {WINDOWS.map((w, i) => (
          <ellipse key={i} cx={w.x + w.w / 2} cy="300" rx="180" ry="150" style={{ fill: "url(#rhBloomCyan)" }} />
        ))}
        {/* warm pools under the pendant lamps */}
        {[236, 612, 1044, 1392].map((x, i) => (
          <ellipse key={`l${x}`} cx={x} cy={300 + i * 14} rx="120" ry="90"
            style={{ fill: "url(#rhBloomWarm)", opacity: "0.5" }} />
        ))}
        {/* warm service lamps */}
        <ellipse cx="1480" cy="470" rx="220" ry="180" style={{ fill: "url(#rhBloomWarm)" }} />
        <ellipse cx="120" cy="560" rx="260" ry="200" style={{ fill: "url(#rhBloomCyan)", opacity: "0.55" }} />

        {/* slow search-light sweep */}
        <g className={still ? undefined : "env-sweep"}>
          <path d="M240 0 L420 0 L760 900 L340 900 Z" style={{ fill: "url(#rhBeamCone)" }} opacity="0.5" />
        </g>
      </svg>

      {/* ── L7 · haze, dust, vignette ──────────────────────────────── */}
      <div className={still ? undefined : "env-haze"} style={{
        position: "absolute", inset: 0,
        background: `linear-gradient(180deg, transparent 38%, var(--env-haze) 62%, transparent 100%)`,
      }} />
      <div style={{
        position: "absolute", inset: 0,
        background: `radial-gradient(120% 90% at 50% 40%, transparent 42%, var(--env-shade) 100%)`,
      }} />
      <div style={{
        position: "absolute", inset: 0,
        background: `linear-gradient(180deg, var(--bg-deep) 0%, transparent 14%, transparent 86%, var(--bg) 100%)`,
        opacity: "0.55",
      }} />
    </div>
  );
}
