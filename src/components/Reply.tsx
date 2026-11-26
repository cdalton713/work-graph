import { useRef, useState } from "react";

interface ReplyProps {
  label: string;
  placeholder: string;
  hint?: string;
  send: (body: string) => Promise<void>;
}

export function Reply({ label, placeholder, hint, send }: ReplyProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      const body = draft.trim();
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
    }}>
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
