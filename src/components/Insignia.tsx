// ─────────────────────────────────────────────────────────────
// RHODES · original geometric insignia.
// A concentric diamond field carrying an abstract "R" mast:
// vertical spine, notch bar, and diagonal signal leg.
// Original artwork — not derived from any existing emblem.
// ─────────────────────────────────────────────────────────────

export function Insignia({ size = 34, accent = "var(--accent)", fg = "var(--text)" }: {
  size?: number; accent?: string; fg?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-label="RHODES insignia" role="img">
      {/* outer diamond frame */}
      <path d="M24 2.5 L45.5 24 L24 45.5 L2.5 24 Z" stroke={accent} strokeWidth="1.6" />
      {/* inner diamond */}
      <path d="M24 9.5 L38.5 24 L24 38.5 L9.5 24 Z" stroke={fg} strokeWidth="0.9" opacity="0.45" />
      {/* abstract R mast */}
      <path d="M20.5 14.5 V33.5" stroke={fg} strokeWidth="2.4" />
      <path d="M20.5 14.5 H25.5 A4.7 4.7 0 0 1 25.5 23.9 H20.5" stroke={fg} strokeWidth="2.4" />
      <path d="M24.2 23.9 L30 33.5" stroke={fg} strokeWidth="2.4" />
      {/* signal tick */}
      <path d="M31.5 15.5 L35 15.5" stroke={accent} strokeWidth="2" />
      <path d="M31.5 19.2 L33.4 19.2" stroke={accent} strokeWidth="2" opacity="0.6" />
      {/* base tick */}
      <path d="M16 33.5 L17.4 33.5" stroke={accent} strokeWidth="2" />
    </svg>
  );
}
