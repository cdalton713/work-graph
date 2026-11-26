const stations = [
  ["You describe the change", "Start with the change you want to make."],
  ["Linear issues in order", "Each issue waits for its blockers."],
  ["Agents work in parallel", "Ready issues can run at the same time."],
  ["You merge and ship", "Review the pull requests, merge, and deploy."],
] as const;

export function Intro() {
  return <div className="intro">
    <ol className="intro-track" aria-label="How Work Graph works">
      {stations.map(([label, description], index) => <li key={label}>
        <svg viewBox="0 0 40 32" role="img" aria-label={label}>
          <title>{label}</title><desc>{description}</desc>
          {index === 2 ? <>
            <path d="M0 16h5l7-9h16l7 9h5 M5 16l7 9h16l7-9" />
            <circle cx="20" cy="7" r="4" /><circle cx="20" cy="25" r="4" />
          </> : <>
            <path d={index === 0 ? "M20 16h20" : index === 3 ? "M0 16h20" : "M0 16h40"} />
            <circle cx="20" cy="16" r="5" />
          </>}
        </svg>
        <span>{label}</span>
      </li>)}
    </ol>
    <p>Work Graph turns a big change into a graph of Linear issues in the order they need to happen.</p>
    <p>Agents work on every ready issue at the same time. Each has its own branch and pull request.</p>
    <p>You see what needs your answer, merge the changes, and deploy.</p>
  </div>;
}
