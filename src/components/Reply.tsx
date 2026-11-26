import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { readDraft, writeDraft } from "../lib/draft";
import { optionForKey, type ReplyOption } from "../lib/options";
import { needsLinearWriteAccess } from "../lib/reply";

interface ReplyProps {
  label: string;
  draftKey?: readonly string[];
  placeholder: string;
  fieldLabel?: string;
  autoFocus?: boolean;
  literalInput?: boolean;
  rows?: number;
  danger?: boolean;
  cancel?: { label: string; run: () => void };
  hint?: string;
  accessHref?: string;
  options?: ReplyOption[];
  send: (body: string) => Promise<void>;
}

const listeners = new Set<() => void>();
const pending = new Set<string>();
const errors = new Map<string, { message: string; needsAccess: boolean }>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify() {
  listeners.forEach((listener) => listener());
}

function session() {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function Reply(props: ReplyProps) {
  return <ReplyForm key={JSON.stringify(props.draftKey)} {...props} />;
}

function ReplyForm({ label, draftKey, placeholder, fieldLabel = label, autoFocus, literalInput, rows = 3, danger, cancel, hint, accessHref, options = [], send }: ReplyProps) {
  const instance = useId();
  const key = draftKey ? JSON.stringify(draftKey) : instance;
  const [localDraft, setLocalDraft] = useState("");
  const draft = useSyncExternalStore(subscribe, () => draftKey ? readDraft(session(), draftKey) : localDraft);
  const sending = useSyncExternalStore(subscribe, () => pending.has(key));
  const setDraft = (text: string) => {
    if (draftKey) {
      writeDraft(session(), draftKey, text);
      notify();
    } else {
      setLocalDraft(text);
    }
  };
  const error = useSyncExternalStore(subscribe, () => errors.get(key));
  const controls = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const group = controls.current;
    const viewport = window.visualViewport;
    const app = group?.closest<HTMLElement>(".app");
    if (!group || !app) return;
    const touch = window.matchMedia("(pointer: coarse)");
    let frame = 0;
    let covered = false;
    function resetViewport() {
      if (!covered) return;
      app?.style.removeProperty("--form-viewport-bottom");
      app?.classList.remove("form-viewport-covered");
      group?.classList.remove("text-send-focused");
      covered = false;
    }
    function reveal(event?: Event) {
      cancelAnimationFrame(frame);
      if (!touch.matches || !group?.contains(document.activeElement)) {
        resetViewport();
        return;
      }
      frame = requestAnimationFrame(() => {
        resetViewport();
        if (!group?.contains(document.activeElement)) return;
        const visible = window.visualViewport;
        if (app && visible) {
          const bottom = visible.height + visible.offsetTop;
          covered = bottom < app.getBoundingClientRect().bottom - 1 && visible.scale <= 1;
          if (covered) {
            app.style.setProperty("--form-viewport-bottom", `${bottom}px`);
            app.classList.add("form-viewport-covered");
            group.classList.add("text-send-focused");
          }
        }
        if (covered || event?.type === "resize") group.scrollIntoView({ block: "nearest" });
      });
    }
    function leave(event: FocusEvent) {
      if (group?.contains(event.relatedTarget as Node | null)) return;
      cancelAnimationFrame(frame);
      resetViewport();
    }
    reveal();
    group.addEventListener("focusin", reveal);
    group.addEventListener("focusout", leave);
    window.addEventListener("resize", reveal);
    viewport?.addEventListener("resize", reveal);
    viewport?.addEventListener("scroll", reveal);
    return () => {
      cancelAnimationFrame(frame);
      group.removeEventListener("focusin", reveal);
      group.removeEventListener("focusout", leave);
      window.removeEventListener("resize", reveal);
      viewport?.removeEventListener("resize", reveal);
      viewport?.removeEventListener("scroll", reveal);
      resetViewport();
    };
  }, []);

  async function submit(body: string) {
    if (!body || pending.has(key)) return;
    pending.add(key);
    errors.delete(key);
    notify();
    try {
      await send(body);
      setDraft("");
    } catch (error) {
      errors.set(key, { message: error instanceof Error ? error.message : String(error), needsAccess: needsLinearWriteAccess(error) });
    } finally {
      pending.delete(key);
      notify();
    }
  }

  function choose(option: ReplyOption) {
    void submit(`${option.label}: ${option.effect}`);
  }

  return (
    <form className="text-send" onSubmit={(e) => {
      e.preventDefault();
      void submit(draft.trim());
    }}>
      {options.length > 0 && <div className="reply-options" role="group" aria-label="Reply options"
        onKeyDown={(e) => {
          const option = optionForKey(e.nativeEvent, options, e.currentTarget.contains(document.activeElement), draft);
          if (!option) return;
          e.preventDefault();
          choose(option);
        }}>
        {options.map((option, index) => (
          <button key={option.label} type="button" disabled={sending} onClick={() => choose(option)}
            aria-keyshortcuts={draft ? undefined : `Alt+${index + 1}`}>
            <strong>{option.label}</strong>
            {option.reason && <span className="sig-fg-done">Recommended. {option.reason}</span>}
            <span>{option.effect}</span>
            {!draft && <kbd>{`⌥${index + 1}`}</kbd>}
          </button>
        ))}
      </div>}
      <div ref={controls}>
        <textarea className="editor" rows={rows} aria-label={fieldLabel} autoFocus={autoFocus}
          placeholder={placeholder.replace(/ ⌘↵ sends it\.$/, "")}
          enterKeyHint="enter" autoCapitalize={literalInput ? "off" : undefined}
          autoCorrect={literalInput ? "off" : undefined}
          value={draft} readOnly={sending} onChange={(e) => {
            if (!pending.has(key)) setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }} />
        <div className="row text-send-actions">
          <button type="submit" className={danger ? "danger" : "primary"} disabled={!draft.trim() || sending}>{sending ? "Sending…" : label}</button>
          {cancel && <button type="button" disabled={sending} onClick={cancel.run}>{cancel.label}</button>}
          <span className="ask-hint text-send-keys">⌘/Ctrl+Enter</span>
          {hint && <span className="ask-hint">{hint}</span>}
        </div>
      </div>
      {error && <p role="alert" className="sig-fg-stop">Send failed. {error.message}
        {error.needsAccess && accessHref && <> <a href={accessHref}>Open the project for Linear access</a>.</>}
      </p>}
    </form>
  );
}
