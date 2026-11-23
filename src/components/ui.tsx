import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
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
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button type="button" className={`ghost copy${copied ? " is-copied" : ""}${className ? ` ${className}` : ""}`}
      title={`${label}: ${text}`} aria-label={copied ? "Copied" : label}
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
