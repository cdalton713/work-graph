import { useEffect, useRef, useState } from "react";
import { usageEnabled } from "../lib/telemetry";
import { accountApi } from "../api";
import { configBlock, doneSteps, firstStep, pollWhileVisible, setupCommands, steps, workspaceKeyLocation, type NewTeam, type NewTeams, type Step } from "../lib/onboarding";
import type { Account } from "../lib/types";
import { AccountError, NameForm, TeamForm, TokenForm, useAccountAction, WorkspaceKeyForm, WorkspaceStatus, type RefreshAccount } from "./Settings";
import { Intro } from "./Intro";
import { CopyButton } from "./ui";

const readme = "https://github.com/cdalton713/work-graph";

function Command({ text, label }: { text: string; label: string }) {
  return <div className="account-command"><pre>{text}</pre><CopyButton text={text} label={label} /></div>;
}

export function Onboarding({ account, refresh, overview }: { account: Account; refresh: RefreshAccount; overview: () => void }) {
  const [step, setStep] = useState<Step>(() => firstStep({ ...account.onboarding, skipped: false }) ?? "name");
  const [drafts, setDrafts] = useState<NewTeams>({});
  const heading = useRef<HTMLHeadingElement>(null);
  const { busy, error, run } = useAccountAction();
  const label = steps.find(({ id }) => id === step)!.label;
  const done = doneSteps(account.onboarding);
  const hasPendingTeam = account.connections.some(({ id, team }) => drafts[id] && drafts[id].key !== team);
  const canOpenOverview = !hasPendingTeam && steps.every(({ id }) => done[id]);
  const next = steps[steps.findIndex(({ id }) => id === step) + 1]?.id;
  const [connectError, setConnectError] = useState("");

  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    if (step !== "connect") return;
    const controller = new AbortController();
    const inactive = () => controller.signal.aborted || document.visibilityState === "hidden";
    let pending = false;
    async function poll() {
      if (pending) return;
      pending = true;
      try {
        const current = await refresh();
        for (const workspace of current.connections) {
          const draft = drafts[workspace.id];
          if (inactive() || !draft || workspace.team === draft.key || workspace.status !== "ok") continue;
          const teams = await accountApi.teams(workspace.id, controller.signal);
          if (inactive() || !teams.some(({ key }) => key === draft.key)) continue;
          await accountApi.updateWorkspace(workspace.id, { team: draft.key });
          if (!inactive()) await refresh();
        }
        if (!controller.signal.aborted) setConnectError("");
      } catch (error) {
        if (!controller.signal.aborted) setConnectError((error as Error).message);
      } finally {
        pending = false;
      }
    }
    const stop = pollWhileVisible(document, () => void poll());
    return () => { controller.abort(); stop(); };
  }, [step, refresh, drafts]);

  const saveDraft = (id: string, team?: NewTeam) => setDrafts((current) => {
    const next = { ...current };
    if (team) next[id] = team;
    else delete next[id];
    return next;
  });
  const skip = () => void run(async () => {
    await accountApi.onboarding({ skipped: true });
    await refresh();
    overview();
  });
  const continueTo = (next: Step) => {
    if (usageEnabled() && (step === "workspaces" || step === "teams" || step === "setup") && done[step]) {
      void accountApi.onboarding({ step }).catch(() => {});
    }
    setStep(next);
  };
  const finish = () => {
    if (usageEnabled()) void accountApi.onboarding({ complete: true }).catch(() => {});
    overview();
  };
  return <main className="account-page">
    <div className="account-content">
      <div className="account-heading"><h1>Setup guide</h1><button onClick={skip} disabled={busy}>Skip for now</button></div>
      <AccountError error={error} />
      <div className="account-guide">
        <nav aria-label="Setup steps">
          <ol>{steps.map(({ id, label }) => <li key={id}>
            <button aria-current={step === id ? "step" : undefined} onClick={() => {
              if (step === id) heading.current?.focus();
              else setStep(id);
            }}><span className={done[id] ? "account-done" : "account-pending"} aria-label={done[id] ? "Done" : "Pending"}>{done[id] ? "✓" : "○"}</span>{label}</button>
          </li>)}</ol>
        </nav>
        <section className="account-card" aria-labelledby="setup-step-heading">
          <h2 ref={heading} id="setup-step-heading" tabIndex={-1}>{label}</h2>
          <div className="account-step" key={step}>
            {step === "welcome" && <Intro />}
            {step === "name" && <NameForm human={account.human} refresh={refresh} next={() => setStep("workspaces")} />}
            {step === "workspaces" && <>
              {account.connections.map((workspace) => <article className="account-item" key={workspace.id}>
                <h3>{workspace.name}</h3><WorkspaceStatus workspace={workspace} />
              </article>)}
              <WorkspaceKeyForm refresh={refresh} />
            </>}
            {step === "teams" && account.connections.map((workspace) => <article className="account-item" key={workspace.id}>
              <h3>{workspace.name}</h3>
              <WorkspaceStatus workspace={workspace} />
              <TeamForm workspace={workspace} draft={drafts[workspace.id]} saveDraft={(team) => saveDraft(workspace.id, team)} refresh={refresh} />
            </article>)}
            {step === "setup" && <>
              <section>
                <h3>Install the skill and tools on your computer</h3>
                <p><a href={readme + "#install-the-skill"} target="_blank" rel="noreferrer">Read the installation instructions</a>.</p>
                <p><a href={readme + "#config"} target="_blank" rel="noreferrer">Set up a local Linear key</a> for each workspace on your computer so <code>wg</code> can work with its team. Set the environment variable or save the key in the file with permissions 600.</p>
                <ul className="account-key-locations">
                  {account.connections.map(({ id, name, workspace_id }) => {
                    const { env, file } = workspaceKeyLocation(workspace_id);
                    return <li key={id}>{name} <code>{env}</code> or <code>{file}</code></li>;
                  })}
                </ul>
              </section>
              <section>
                <h3>Set up the config on your computer</h3>
                <p>Add these settings to <code>~/.config/work-graph/config.json</code>.</p>
                {account.connections.some(({ id, team }) => !team && !drafts[id]) && <p>Choose a team for each workspace before you run the setup commands.</p>}
                <Command text={configBlock(account, drafts)} label="Copy wg config" />
              </section>
              <section><h3>Coordinator token</h3><TokenForm refresh={refresh} /></section>
              <section className="account-form">
                <h3>Run these commands on your computer</h3>
                <p>Run them in order. Paste the token when <code>wg login</code> asks for it.</p>
                {setupCommands(account, drafts).map((command) => <Command key={command} text={command} label={`Copy ${command}`} />)}
              </section>
            </>}
            {step === "connect" && <>
              <p role="status">{account.onboarding.connected ? <><code>wg</code> is connected.</> :
                <>Waiting for <code>wg</code> to connect. Run <code>wg login</code> and <code>wg doctor</code> on your machine.</>}</p>
              {hasPendingTeam &&
                <p>Waiting for <code>wg setup</code> to create your new team in Linear.</p>}
              <AccountError error={connectError} />
              {canOpenOverview && <div><button className="primary" onClick={finish}>Go to overview</button></div>}
            </>}
            {next && step !== "name" && <div><button onClick={() => continueTo(next)}>Continue</button></div>}
          </div>
        </section>
      </div>
    </div>
  </main>;
}
