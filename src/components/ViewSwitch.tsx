export type ProjectView = "list" | "graph";

export function ViewSwitch({ view, onChange }: { view: ProjectView; onChange: (view: ProjectView) => void }) {
  return (
    <div className="view-switch" role="group" aria-label="Project view">
      <button type="button" aria-pressed={view === "list"} onClick={() => onChange("list")}>List</button>
      <button type="button" aria-pressed={view === "graph"} onClick={() => onChange("graph")}>Graph</button>
    </div>
  );
}
