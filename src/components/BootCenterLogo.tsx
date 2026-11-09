// ─────────────────────────────────────────────────────────────
// RHODES · boot / command-centre mark.
//
// The circular insignia used by the startup sequence and the
// Command Center identity stage. `public/Boot_Center_logo.png`
// (1965 × 1965, RGBA, transparent corners) is presented as-is:
// no crop, no stretch, no recolour, no appearance filters.
//
// This component exists so the two intended placements can use the
// artwork while `RhodesLogo` keeps pointing at the official
// `RHODES.png` used by the HUD chip, the favicon and the touch icon.
// ─────────────────────────────────────────────────────────────

export const BOOT_CENTER_LOGO_SRC = "/Boot_Center_logo.png";
/** Natural pixel size of the shipped asset — square, keeps layout shift at zero. */
export const BOOT_CENTER_LOGO_SIZE = 1965;

export function BootCenterLogo({
  className = "",
  alt = "RHODES logo",
}: {
  className?: string;
  alt?: string;
}) {
  return (
    <img
      src={BOOT_CENTER_LOGO_SRC}
      alt={alt}
      width={BOOT_CENTER_LOGO_SIZE}
      height={BOOT_CENTER_LOGO_SIZE}
      draggable={false}
      className={`boot-center-logo${className ? ` ${className}` : ""}`}
    />
  );
}
