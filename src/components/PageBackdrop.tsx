// ─────────────────────────────────────────────────────────────
// RHODES · page backdrop.
//
// One decorative, page-scoped artwork layer for the operations
// screens. It sits behind the page content (z-index 0), never takes
// pointer events, and is clipped to the page box, so it can never
// reach another screen or the chrome.
//
// The artwork keeps its natural aspect ratio and is painted with
// `background-size: cover`; the theme-aware scrim on top of it is
// what keeps headings and surrounding copy readable, while the
// opaque panels keep their own surfaces untouched.
// ─────────────────────────────────────────────────────────────

export type BackdropScreen = "meetings" | "personnel";

const ARTWORK: Record<BackdropScreen, string> = {
  meetings: "/Meeting_operations_bg.png",
  personnel: "/Personnel_bg.png",
};

export function PageBackdrop({ screen }: { screen: BackdropScreen }) {
  return (
    <div className="page-backdrop" data-screen={screen} aria-hidden="true" role="presentation">
      <div
        className="page-backdrop-art"
        style={{ backgroundImage: `url("${ARTWORK[screen]}")` }}
      />
      <div className="page-backdrop-scrim" />
    </div>
  );
}
