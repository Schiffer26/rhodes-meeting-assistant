// ─────────────────────────────────────────────────────────────
// RHODES · official logo.
//
// Single source of truth for the brand mark: the uploaded
// artwork in `public/RHODES.png` (1536 × 1024, sRGB, opaque).
// The asset already carries its own near-black field, so the
// mark is presented as-is — no cropping, recolouring, filters
// or stretching. Every usage goes through this component so the
// application can never drift back to placeholder artwork.
// ─────────────────────────────────────────────────────────────

export const RHODES_LOGO_SRC = "/RHODES.png";
/** Natural pixel size of the shipped asset — keeps layout shift at zero. */
export const RHODES_LOGO_WIDTH = 1536;
export const RHODES_LOGO_HEIGHT = 1024;

export function RhodesLogo({
  className = "",
  alt = "RHODES logo",
}: {
  className?: string;
  alt?: string;
}) {
  return (
    <img
      src={RHODES_LOGO_SRC}
      alt={alt}
      width={RHODES_LOGO_WIDTH}
      height={RHODES_LOGO_HEIGHT}
      draggable={false}
      className={`rhodes-logo${className ? ` ${className}` : ""}`}
    />
  );
}
