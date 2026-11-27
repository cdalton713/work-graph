// The hold control of the bar: "Hold…" opens a form; a held project shows "On hold" and its details.
import { type FormEvent, useState } from "react";
import { HOLD_EVERY_DEFAULT, type Hold as HoldRecord, type HoldInput, holdEnded, holdText } from "../lib/hold";
import { Sheet } from "./ui";

const EVERY = [
  { hours: 6, label: "Every 6 hours" },
  { hours: 12, label: "Every 12 hours" },
  { hours: 24, label: "Daily" },
  { hours: 72, label: "Every 3 days" },
  { hours: 168, label: "Weekly" },
];

export function HoldControl({ held, hold, now, onHold, onResume, onDone }: {
  /** The project has the label `on-hold`. */
  held: boolean;
  hold: HoldRecord | null | undefined;
  now: number;
  onHold: (hold: HoldInput) => Promise<void>;
  onResume: () => Promise<void>;
  /** Close a menu that holds the button. */
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ended = hold ? holdEnded(hold, now) : null;
  const label = !held ? "Hold…" : ended ? "Hold ended" : "On hold";
  return <>
    <button type="button" className={`ghost bar-hold${held ? " is-held" : ""}${ended ? " is-ended" : ""}`} aria-haspopup="dialog"
      onClick={() => setOpen(true)}>{label}</button>
    {open && <HoldSheet held={held} hold={hold} now={now} onHold={onHold} onResume={onResume}
      onClose={() => { setOpen(false); onDone?.(); }} />}
  </>;
}

function HoldSheet({ held, hold, now, onHold, onResume, onClose }: {
  held: boolean; hold: HoldRecord | null | undefined; now: number;
  onHold: (hold: HoldInput) => Promise<void>; onResume: () => Promise<void>; onClose: () => void;
}) {
  const [waitingFor, setWaitingFor] = useState("");
  const [until, setUntil] = useState("");
  const [check, setCheck] = useState("");
  const [everyHours, setEveryHours] = useState(HOLD_EVERY_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => onHold({ waitingFor: waitingFor.trim(), until: until || null, check: check.trim() || null, everyHours }));
  };

  if (held) {
    const ended = hold ? holdEnded(hold, now) : null;
    return <Sheet open title="On hold" onClose={() => { if (!busy) onClose(); }}>
      <div className="account-form hold-form">
        <p>{hold ? holdText(hold, now) : "This project has the label on-hold, but Linear has no hold update for it."}</p>
        {ended && <p><b>The hold ended:</b> {ended}.</p>}
        {hold?.check && <p>Agent check, {EVERY.find((e) => e.hours === hold.everyHours)?.label.toLowerCase() ?? `every ${hold.everyHours} hours`}: {hold.check}</p>}
        {hold?.lastCheck?.evidence && <p>Last result: {hold.lastCheck.evidence}</p>}
        <p>The coordinator is paused. Resume ends the hold and lets the coordinator act again.</p>
        {error && <p className="account-error" role="alert">{error}</p>}
        <button type="button" className="primary" disabled={busy} onClick={() => void run(onResume)}>{busy ? "Resuming…" : "End the hold and resume"}</button>
      </div>
    </Sheet>;
  }

  return <Sheet open title="Put on hold" onClose={() => { if (!busy) onClose(); }}>
    <form className="account-form hold-form" onSubmit={submit}>
      <p>The project leaves the Overview list and the inbox, and the coordinator pauses. The project comes back as your move on the date, or when the agent check says the wait is over.</p>
      <label>Waiting for<input required maxLength={200} disabled={busy} value={waitingFor} placeholder="Shopify app review"
        onChange={(e) => setWaitingFor(e.target.value)} /></label>
      <label>Until (optional)<input type="date" disabled={busy} value={until} onChange={(e) => setUntil(e.target.value)} /></label>
      <label>Agent check (optional)<textarea rows={3} maxLength={2000} disabled={busy} value={check} aria-describedby="hold-check-help"
        placeholder="Has Shopify replied to the app review in #shopify-partners or by email?" onChange={(e) => setCheck(e.target.value)} /></label>
      <small id="hold-check-help">wg tick on your machine asks your agent this question, with your connectors. A yes ends the hold.</small>
      {check.trim() && <label>Check<select disabled={busy} value={everyHours} onChange={(e) => setEveryHours(Number(e.target.value))}>
        {EVERY.map((e) => <option key={e.hours} value={e.hours}>{e.label}</option>)}
      </select></label>}
      {error && <p className="account-error" role="alert">{error}</p>}
      <button className="primary" disabled={busy || !waitingFor.trim()}>{busy ? "Saving…" : "Put on hold"}</button>
    </form>
  </Sheet>;
}
