import { useRef, useState } from "react";
import type { ReplyOption } from "../lib/options";

interface ReplyProps {
  label: string;
  placeholder: string;
  hint?: string;
  options?: ReplyOption[];
  send: (body: string) => Promise<void>;
}

export function Reply({ label, placeholder, hint, options = [], send }: ReplyProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  async function submit(body: string) {
    if (!body || pending.current) return;
    pending.current = true;
    setSending(true);
    setError(null);
    try {
      await send(body);
      setDraft("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
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
      void submit(draft.trim());
    }} onKeyDown={(e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat || e.nativeEvent.isComposing) return;
      const digit = /^Digit([1-4])$/.exec(e.code);
      const option = digit && options[Number(digit[1]) - 1];
      if (!option) return;
      e.preventDefault();
      choose(option);
    }}>
      {options.length > 0 && <div className="reply-options" role="group" aria-label="Reply options">
        {options.map((option, index) => (
          <button key={option.label} type="button" disabled={sending} onClick={() => choose(option)}
            aria-keyshortcuts={`Alt+${index + 1}`}>
            <strong>{option.label}</strong>
            {option.reason && <span className="sig-fg-done">Recommended. {option.reason}</span>}
            <span>{option.effect}</span>
            <kbd>{`Alt+${index + 1}`}</kbd>
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
      {error && <p role="alert" className="sig-fg-stop">Send failed. {error}</p>}
      <div className="row">
        <button type="submit" className="primary" disabled={!draft.trim() || sending}>{sending ? "Sending…" : label}</button>
        {hint && <span className="ask-hint">{hint}</span>}
      </div>
    </form>
  );
}
