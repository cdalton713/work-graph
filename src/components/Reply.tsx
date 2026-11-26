import { useRef, useState } from "react";
import { optionForKey, type ReplyOption } from "../lib/options";
import { needsLinearWriteAccess } from "../lib/reply";

interface ReplyProps {
  label: string;
  placeholder: string;
  hint?: string;
  accessHref?: string;
  options?: ReplyOption[];
  send: (body: string) => Promise<void>;
}

export function Reply({ label, placeholder, hint, accessHref, options = [], send }: ReplyProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; needsAccess: boolean } | null>(null);
  const pending = useRef(false);

  async function submit(body: string, fromDraft = false) {
    if (!body || pending.current) return;
    pending.current = true;
    setSending(true);
    setError(null);
    try {
      await send(body);
      if (fromDraft) setDraft("");
    } catch (error) {
      setError({ message: error instanceof Error ? error.message : String(error), needsAccess: needsLinearWriteAccess(error) });
    } finally {
      pending.current = false;
      setSending(false);
    }
  }

  function choose(option: ReplyOption) {
    void submit(`${option.label}: ${option.effect}`);
  }

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      void submit(draft.trim(), true);
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
      <textarea className="editor" rows={3} aria-label={label} placeholder={placeholder}
        value={draft} readOnly={sending} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }} />
      {error && <p role="alert" className="sig-fg-stop">Send failed. {error.message}
        {error.needsAccess && accessHref && <> <a href={accessHref}>Open the project for Linear access</a>.</>}
      </p>}
      <div className="row">
        <button type="submit" className="primary" disabled={!draft.trim() || sending}>{sending ? "Sending…" : label}</button>
        {hint && <span className="ask-hint">{hint}</span>}
      </div>
    </form>
  );
}
