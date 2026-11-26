import type { ReactNode } from "react";
import type { EffortStatus } from "../lib/graph";
import { Sheet } from "./ui";

export function EffortSheet({ open, onClose, summary, lines, age, changed, coordinator, coordinatorDetail,
  coordinatorNotice, staleDetail, children }: {
  open: boolean;
  onClose: () => void;
  summary?: string;
  lines?: EffortStatus["lines"];
  age?: string | null;
  changed: boolean;
  coordinator?: string;
  coordinatorDetail?: string;
  coordinatorNotice: string | null;
  staleDetail?: string;
  children: ReactNode;
}) {
  return <Sheet open={open} title="wg next" onClose={onClose}>
    <div className="effort-details">
      {summary && <p>{summary}</p>}
      {age && <p>{changed ? "Result changed" : "Published"} {age}</p>}
      <p>{coordinator ?? "Coordinator state is unavailable."}</p>
      {coordinatorNotice && <p>{coordinatorNotice}</p>}
      {coordinatorDetail && <p>{coordinatorDetail}</p>}
      {staleDetail && <p>{staleDetail}</p>}
      {!!lines?.length && <ul>
        {lines.map(({ level, text }, index) => <li key={index}>{level} {text}</li>)}
      </ul>}
      {children}
    </div>
  </Sheet>;
}
