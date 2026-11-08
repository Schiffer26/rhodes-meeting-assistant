// RHODES · Industrial Background Environment
// Original CSS/SVG composition mimicking an advanced industrial vessel.
import React from "react";
import { useAppData, useMotionScale } from "@/hooks/store";

export function BackgroundEnvironment() {
  const { data } = useAppData();
  const { off } = useMotionScale();
  const isLight = data.settings.theme === "archive";

  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 0, pointerEvents: "none", overflow: "hidden",
      background: isLight ? "#D9DDE0" : "#0d1012"
    }}>
      {/* Base Grid */}
      <div className="ambient-grid" style={{ opacity: isLight ? 0.3 : 0.2 }} />

      {/* Structural beams (Abstract SVG) */}
      <svg width="100%" height="100%" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, opacity: isLight ? 0.4 : 0.6 }}>
        <defs>
          <linearGradient id="beamGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={isLight ? "#ffffff" : "#1a1e23"} />
            <stop offset="100%" stopColor={isLight ? "#c0c4c8" : "#080a0c"} />
          </linearGradient>
          <pattern id="hatch" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="40" stroke={isLight ? "#e0e0e0" : "#202428"} strokeWidth="10" />
          </pattern>
        </defs>

        {/* Diagonal main beam */}
        <polygon points="0,200 400,0 480,0 0,240" fill="url(#beamGrad)" />
        {/* Horizontal structure */}
        <rect x="0" y="60%" width="100%" height="40" fill="url(#beamGrad)" />
        <rect x="0" y="60%" width="100%" height="40" fill="url(#hatch)" opacity="0.3" />
        
        {/* Right side large pillar */}
        <polygon points="80%,0 90%,0 100%,100% 90%,100%" fill="url(#beamGrad)" />
        <polygon points="90%,0 92%,0 98%,100% 96%,100%" fill={isLight ? "#b0b0b0" : "#050709"} opacity="0.5" />
      </svg>

      {/* Ambient lights */}
      {!off && (
        <>
          <div style={{ position: "absolute", top: "20%", left: "15%", width: 300, height: 300, background: "var(--accent)", filter: "blur(120px)", opacity: isLight ? 0.15 : 0.08, borderRadius: "50%" }} />
          <div style={{ position: "absolute", bottom: "10%", right: "20%", width: 400, height: 400, background: "var(--warn)", filter: "blur(150px)", opacity: isLight ? 0.1 : 0.05, borderRadius: "50%" }} />
        </>
      )}

      {/* Subtle overlay for legibility */}
      <div style={{ position: "absolute", inset: 0, background: isLight ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.4)" }} />
    </div>
  );
}
