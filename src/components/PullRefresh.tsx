import { useEffect, useState, type RefObject } from "react";
import { pullDistance } from "../lib/screen";

const THRESHOLD = 72;

export function PullRefresh({ stage, onRefresh, busy }: {
  stage: RefObject<HTMLElement | null>; onRefresh: () => void; busy: boolean;
}) {
  const [pull, setPull] = useState(0);

  useEffect(() => {
    const root = stage.current;
    setPull(0);
    if (!root || busy) return;
    let start: { x: number; y: number; scroller: Element } | null = null;
    const openOverlay = CSS.supports("selector(:popover-open)") ? "dialog[open], :popover-open" : "dialog[open]";
    const cancel = () => { start = null; setPull(0); };
    const begin = (event: TouchEvent) => {
      cancel();
      if (event.touches.length !== 1 || !(event.target instanceof Element) ||
        document.querySelector(openOverlay)) return;
      const target = event.target;
      if (target.closest(".panel, dialog, input, textarea, select, [contenteditable]")) return;
      const scroller = target.closest(".board-scroll") ?? (target.closest(".overview") && root);
      if (!scroller || scroller.scrollTop > 0) return;
      for (let node: Element | null = target; node && node !== scroller; node = node.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(node);
        const scrollable = /^(auto|scroll|overlay)$/;
        if (node.scrollHeight > node.clientHeight && scrollable.test(overflowY)) return;
        if (node.scrollWidth > node.clientWidth && scrollable.test(overflowX)) return;
      }
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY, scroller };
    };
    const distance = (touch: Touch) => start ? pullDistance(touch.clientX - start.x, touch.clientY - start.y) : 0;
    const move = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1 || start.scroller.scrollTop > 0) { cancel(); return; }
      const touch = event.touches[0];
      if (touch.clientY < start.y - 8 || Math.abs(touch.clientX - start.x) > Math.max(16, touch.clientY - start.y)) {
        cancel();
        return;
      }
      const down = distance(touch);
      if (down > 8 && event.cancelable) event.preventDefault();
      setPull(down);
    };
    const end = (event: TouchEvent) => {
      const refresh = start && start.scroller.scrollTop <= 0 && event.changedTouches.length === 1 &&
        distance(event.changedTouches[0]) >= THRESHOLD;
      cancel();
      if (refresh) onRefresh();
    };
    root.addEventListener("touchstart", begin, { passive: true });
    root.addEventListener("touchmove", move, { passive: false });
    root.addEventListener("touchend", end);
    root.addEventListener("touchcancel", cancel);
    return () => {
      root.removeEventListener("touchstart", begin);
      root.removeEventListener("touchmove", move);
      root.removeEventListener("touchend", end);
      root.removeEventListener("touchcancel", cancel);
    };
  }, [stage, onRefresh, busy]);

  return pull > 16 ? <div className="pull-refresh" aria-hidden="true">
    {pull >= THRESHOLD ? "Release to refresh" : "Pull down to refresh"}
  </div> : null;
}
