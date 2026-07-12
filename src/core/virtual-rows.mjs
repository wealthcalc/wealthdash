// Pure range math for windowed ("virtualised") table rendering — see
// ui/shared.jsx's useVirtualRows for the DOM-facing hook that calls this on
// every scroll/resize event.
//
// WHY NOT A VIRTUALIZATION LIBRARY: libraries like react-window render each
// row as an absolutely-positioned element. Per the CSS spec (going back to
// CSS2.1 §9.7, still true today), an element with position:absolute has its
// computed `display` forced from `table-row` to `block` — so an absolutely
// positioned <tr> silently stops behaving like a table row and its cells
// lose column alignment with the rest of the table. Rather than rewrite
// these tables from <table> to a CSS-grid of <div>s just to route around
// that, this uses the older "spacer <tr> + scroll-position math" technique:
// every rendered row is a REAL <tr> in normal document flow (thead can stay
// `position: sticky`, which is NOT subject to the same rule), and two
// spacer rows stand in for the height of everything above/below the
// rendered window so the scrollbar still represents the full row count.
//
// Below VIRTUALIZE_THRESHOLD (see shared.jsx) callers skip all of this and
// render the plain, un-windowed table exactly as before — the overwhelming
// majority of users never cross it, and that keeps the zero-risk path
// completely unchanged.
export function computeVisibleRange({ scrollTop, clientHeight, rowHeight, rowCount, overscan = 8 }) {
  if (!(rowCount > 0) || !(rowHeight > 0)) return { start: 0, end: 0, topPad: 0, bottomPad: 0 };
  const st = Math.max(0, scrollTop || 0);
  const ch = Math.max(0, clientHeight || 0);
  const visibleCount = Math.max(1, Math.ceil(ch / rowHeight));
  const start = Math.max(0, Math.min(rowCount, Math.floor(st / rowHeight) - overscan));
  const end = Math.max(start, Math.min(rowCount, start + visibleCount + overscan * 2));
  return {
    start,
    end,
    topPad: start * rowHeight,
    bottomPad: Math.max(0, (rowCount - end) * rowHeight),
  };
}
