import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCoarse, useHover } from "../lib/screen";
import type { Signal } from "../lib/graph";
import type { PullRequest } from "../lib/types";

/** The colour is the status. `pulse` is only for an issue that a worker runs on now: no other lamp moves. */
export function Lamp({ signal, pulse }: { signal: Signal; pulse?: boolean }) {
  return <span className={`lamp lamp-${signal}${pulse ? " lamp-pulse" : ""}`} aria-hidden />;
}

/** Puts `text` on the clipboard. A page without the Clipboard API (plain http) uses a hidden field. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch { /* falls through to the field */ }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

/** A small button that copies `text`, then shows "Copied" for a short time. */
export function CopyButton({ text, label, className, secret }: { text: string; label: string; className?: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button type="button" className={`ghost copy${copied ? " is-copied" : ""}${className ? ` ${className}` : ""}`}
      title={secret ? label : `${label}: ${text}`} aria-label={copied ? "Copied" : label}
      onClick={(e) => { e.stopPropagation(); void copyText(text).then(() => setCopied(true)); }}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** The two places to open a pull request: GitHub, and Linear's review page when Linear has it. */
export function PrLinks({ pr, compact }: { pr: PullRequest; compact?: boolean }) {
  return (
    <span className="pr-links">
      <a href={pr.url} target="_blank" rel="noopener noreferrer" title={`Open #${pr.number} in GitHub`}>{compact ? "GitHub" : "GitHub ↗"}</a>
      {pr.reviewUrl && <a href={pr.reviewUrl} target="_blank" rel="noopener noreferrer" title={`Open #${pr.number} in Linear review`}>{compact ? "Linear" : "Linear review ↗"}</a>}
    </span>
  );
}

export interface Option { id: string; label: string; hint?: string; lead?: ReactNode; group?: string; dim?: boolean }

/**
 * A trigger with a list below it. `multi` keeps the list open and toggles entries. An option with a
 * `group` starts a new heading when the group changes. The arrow keys move, Enter picks.
 */
export function Picker(props: {
  options: Option[]; value: string[]; onChange: (ids: string[]) => void; multi?: boolean;
  children: ReactNode; disabled?: boolean; align?: "left" | "right"; title?: string; wide?: boolean;
}) {
  const { options, value, onChange, multi, children, disabled, align = "left", title, wide } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const shown = options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  // The list opens on the selected entry, so the keys move from there.
  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, shown.findIndex((o) => value.includes(o.id))));
    (list.current?.querySelector(".picker-filter") as HTMLElement | null ?? list.current)?.focus();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { list.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" }); }, [active]);
  const pick = (id: string) => {
    if (!multi) {
      setOpen(false);
      if (value[0] !== id) onChange([id]);
    } else onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };
  const onKey = (e: KeyboardEvent) => {
    const move = (to: number) => { e.preventDefault(); setActive(Math.min(shown.length - 1, Math.max(0, to))); };
    if (e.key === "ArrowDown") move(active + 1);
    else if (e.key === "ArrowUp") move(active - 1);
    else if (e.key === "Home" && !query) move(0);
    else if (e.key === "End" && !query) move(shown.length - 1);
    else if (e.key === "Enter" && shown[active]) { e.preventDefault(); pick(shown[active].id); }
    else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
      if (e.key === "Escape") root.current?.querySelector<HTMLElement>(".picker-trigger")?.focus();
    }
  };
  return (
    <div className="picker" ref={root}>
      <button type="button" className="picker-trigger" disabled={disabled} title={title} aria-expanded={open} aria-haspopup="listbox"
        onClick={() => { setOpen(!open); setQuery(""); }}>
        {children}
      </button>
      {open && (
        <div className={`picker-list picker-${align}${wide ? " picker-wide" : ""}`} ref={list} tabIndex={-1} onKeyDown={onKey}>
          {options.length > 8 && <input className="picker-filter" placeholder="Filter" value={query} aria-label="Filter"
            onChange={(e) => { setQuery(e.target.value); setActive(0); }} />}
          <div className="picker-scroll" role="listbox" aria-multiselectable={multi || undefined}>
            {shown.map((o, i) => {
              const on = value.includes(o.id);
              return (
                <div key={o.id} role="presentation">
                  {o.group && o.group !== shown[i - 1]?.group && <div className="picker-group" role="presentation">{o.group}</div>}
                  <button type="button" role="option" aria-selected={on} tabIndex={-1}
                    className={`picker-option${on ? " is-selected" : ""}${i === active ? " is-active" : ""}${o.dim ? " is-dim" : ""}`}
                    onMouseMove={() => i !== active && setActive(i)} onClick={() => pick(o.id)}>
                    {o.lead}<span className="picker-label" title={o.label}>{o.label}</span>
                    {o.hint && <span className="picker-hint">{o.hint}</span>}
                    <span className="picker-check" aria-hidden>{on ? "✓" : ""}</span>
                  </button>
                </div>
              );
            })}
            {!shown.length && <div className="picker-empty">No match</div>}
          </div>
        </div>
      )}
    </div>
  );
}

const markdownComponents: Components = {
  a: ({ href, children, title }) => <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>,
};

/** Linear Markdown. A `+++ Title … +++` section becomes a closed fold, as in Linear. */
export function Rich({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const fold = /^\+\+\+[ \t]*(.*)\n([\s\S]*?)\n\+\+\+[ \t]*$/gm;
  let at = 0;
  for (let m = fold.exec(text); m; m = fold.exec(text)) {
    if (m.index > at) parts.push(<Markdown key={at} remarkPlugins={[remarkGfm]} components={markdownComponents}>{text.slice(at, m.index)}</Markdown>);
    parts.push(
      <details key={`f${m.index}`} className="fold">
        <summary>{m[1] || "Details"}</summary>
        <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{m[2]}</Markdown>
      </details>,
    );
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push(<Markdown key={at} remarkPlugins={[remarkGfm]} components={markdownComponents}>{text.slice(at)}</Markdown>);
  return <div className="rich">{parts}</div>;
}

/** Use infoLabel when the child has its own action. It names the separate hint button. */
export function Hint({ text, children, className, infoLabel }: {
  text: string;
  children: ReactNode;
  className?: string;
  infoLabel?: string;
}) {
  const hover = useHover();
  const coarse = useCoarse();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLSpanElement>(null);
  const nativeTitle = hover && !coarse;

  function position() {
    const anchor = trigger.current;
    const tip = popover.current;
    if (!anchor || !tip?.matches(":popover-open")) return;

    const gap = 8;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? document.documentElement.clientWidth;
    const height = viewport?.height ?? document.documentElement.clientHeight;
    const anchorRect = anchor.getBoundingClientRect();
    tip.style.maxWidth = `min(28ch, ${Math.max(0, width - gap * 2)}px)`;
    tip.style.maxHeight = `${Math.max(0, height - gap * 2)}px`;
    const tipRect = tip.getBoundingClientRect();
    const below = anchorRect.bottom + gap;
    const above = anchorRect.top - tipRect.height - gap;
    const y = below + tipRect.height <= top + height - gap ? below : above;
    tip.style.left = `${Math.max(left + gap, Math.min(anchorRect.left, left + width - tipRect.width - gap))}px`;
    tip.style.top = `${Math.max(top + gap, Math.min(y, top + height - tipRect.height - gap))}px`;
  }

  useEffect(() => {
    if (nativeTitle) return;
    const viewport = window.visualViewport;
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [nativeTitle]);

  if (nativeTitle) return <span className={className} title={text}>{children}</span>;

  return <span className={className ? `hint ${className}` : "hint"}>
    {infoLabel && children}
    <button type="button" className="hint-trigger"
      aria-label={infoLabel} aria-describedby={id} popoverTarget={id} ref={trigger}>
      {infoLabel ? <span className="hint-mark" aria-hidden>i</span> : children}
    </button>
    <span id={id} className="hint-popover" role="tooltip" popover="auto" ref={popover} onToggle={position}>
      {text}
    </span>
  </span>;
}

/** A modal panel anchored to the bottom of the window. */
export function Sheet({ open, title, onClose, children }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  const heading = useId();

  useLayoutEffect(() => {
    const panel = dialog.current;
    if (!open || !panel) return;
    panel.showModal();
    return () => panel.close();
  }, [open]);

  function keepTabInside(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab" || event.defaultPrevented) return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, [tabindex], [contenteditable]",
    )].filter((control) => control.tabIndex >= 0 && !control.matches(":disabled")
      && control.getClientRects().length && getComputedStyle(control).visibility === "visible");
    const first = controls.at(0);
    const last = controls.at(-1);
    const active = document.activeElement;
    if (event.shiftKey ? active === first : active === last) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  }

  function outside(panel: HTMLDialogElement, x: number, y: number) {
    const rect = panel.getBoundingClientRect();
    return x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom;
  }

  return <dialog ref={dialog} className="sheet" aria-labelledby={heading} onKeyDown={keepTabInside}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onPointerDown={(event) => {
      backdropPress.current = event.target === event.currentTarget
        && outside(event.currentTarget, event.clientX, event.clientY);
    }}
    onClick={(event) => {
      if (backdropPress.current && event.target === event.currentTarget
        && outside(event.currentTarget, event.clientX, event.clientY)) onClose();
      backdropPress.current = false;
    }}>
    <div className="sheet-layout">
      <header className="sheet-header">
        <h2 id={heading}>{title}</h2>
        <button type="button" className="sheet-close" aria-label="Close" onClick={onClose} autoFocus>×</button>
      </header>
      <div className="sheet-body">{children}</div>
    </div>
  </dialog>;
}
