import { type ReactNode, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { DESKTOP_MIN_WIDTH } from "../lib/screen";
import { Sheet } from "./ui";

const compactQuery = `(max-width: ${DESKTOP_MIN_WIDTH - 1}px)`;

export function useCompactBar() {
  return useSyncExternalStore(subscribe, () => matchMedia(compactQuery).matches, () => false);
}

function subscribe(onChange: () => void) {
  const media = matchMedia(compactQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function BarMenu({ title, children }: {
  title: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return <>
    <button type="button" className="ghost bar-more" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>More</button>
    {open && createPortal(
      <Sheet open title={title} onClose={close}>
        <div className="bar-menu">{children(close)}</div>
      </Sheet>,
      document.body,
    )}
  </>;
}
