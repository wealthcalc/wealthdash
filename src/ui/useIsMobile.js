import { useState, useEffect } from "react";

// Matches Tailwind's default `sm` breakpoint (640px) — the same width the
// existing DesktopSidebar/MobileDrawer split already uses (`hidden sm:flex`
// / `sm:hidden` in ui/Sidebar.jsx), so "mobile" here means exactly the width
// at which the app already swaps to the hamburger-drawer nav. One source of
// truth for "is this a phone-sized viewport", used by the read-only mobile
// summary layer in CgtDashboard.jsx.
const QUERY = "(max-width: 639px)";

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(QUERY).matches
      : false
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(QUERY);
    const onChange = (e) => setIsMobile(e.matches);
    // Safari <14 only supports addListener/removeListener; both are covered.
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else mql.addListener(onChange);
    setIsMobile(mql.matches);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else mql.removeListener(onChange);
    };
  }, []);
  return isMobile;
}

export default useIsMobile;
