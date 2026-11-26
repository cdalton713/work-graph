const stations = [
  ["You describe the change", "Say what should change and why."],
  ["Linear issues in order", "Each issue shows what must finish first."],
  ["Agents work in parallel", "One branch and pull request per ready issue."],
  ["You merge and ship", "Review the pull requests, merge, and deploy."],
] as const;

export function Intro() {
  return <div className="intro">
    <ol className="intro-track" aria-label="How Work Graph works">
      {stations.map(([label, description], index) => <li key={label}>
        <svg viewBox="0 0 40 32" aria-hidden="true">
          <title>{label}</title><desc>{description}</desc>
          {index === 2 ? <>
            <path d="M0 16h5l7-9h16l7 9h5 M5 16l7 9h16l7-9" />
            <circle cx="20" cy="7" r="4" /><circle cx="20" cy="25" r="4" />
          </> : <>
            <path d={index === 0 ? "M20 16h20" : index === 3 ? "M0 16h20" : "M0 16h40"} />
            <circle cx="20" cy="16" r="5" />
          </>}
        </svg>
        <span>{label}<small>{description}</small></span>
      </li>)}
    </ol>
    <p>Work Graph turns a big change into a graph of Linear issues in the order they need to happen.</p>
    <p>Ready issues can move together while blocked issues wait. You can see everything that needs your attention in one place.</p>
    <p>You answer questions, merge the changes, and deploy.</p>
  </div>;
}
