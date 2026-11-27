import { useCallback, useEffect, useRef, useState } from "react";
import { usageEnabled } from "../lib/telemetry";
import { accountApi } from "../api";
import { configBlock, installBlock, doneSteps, firstStep, pollWhileVisible, setupCommands, steps, workspaceKeyLocation, type Step } from "../lib/onboarding";
import type { Account, SetupTeam } from "../lib/types";
import { AccountError, ConnectWorkspace, copySecret, NameForm, TokenForm, useAccountAction, WorkspaceStatus, type RefreshAccount } from "./Settings";
import { Intro } from "./Intro";
import { CopyButton } from "./ui";
import { WorkspaceSetup } from "./onboarding/WorkspaceSetup";

const readme = "https://github.com/cdalton713/work-graph";

function CopyAll({ text }: { text: string }) {
  const [message, setMessage] = useState("");
  return <div className="account-actions">
    <button onClick={async event => {
      const copied = await copySecret(text, event.currentTarget);
      setMessage(copied ? "Commands copied." : "Select and copy the commands.");
    }}>Copy all</button>
    <span role="status">{message}</span>
  </div>;
}

function Command({ text, label }: { text: string; label: string }) {
  return <div className="account-command"><pre>{text}</pre><CopyButton text={text} label={label} /></div>;
}

export function Onboarding({ account, refresh, overview }: { account: Account; refresh: RefreshAccount; overview: () => void }) {
  // After Linear returns from a workspace connection, show its result on the workspaces step.
  const [step, setStep] = useState<Step>(() => new URLSearchParams(location.search).has("connect") ? "workspaces"
    : firstStep({ ...account.onboarding, skipped: false }, false) ?? "name");
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const focusCreated = useRef<string | null>(null);
  const [created, setCreated] = useState<Record<string, SetupTeam>>({});
  const record = useCallback((key: string, ready: boolean) => {
    setVerified(previous => previous[key] === ready ? previous : { ...previous, [key]: ready });
  }, []);
  const setupKey = (w: Account["connections"][number]) => JSON.stringify([w.id, w.team, w.team_labels, w.status, account.human]);
  const heading = useRef<HTMLHeadingElement>(null);
  const { busy, error, run } = useAccountAction();
  const label = steps.find(({ id }) => id === step)!.label;
  const statuses = account.connections.length > 0 && account.connections.every(w => verified[setupKey(w)]);
  const done = doneSteps(account.onboarding, statuses);
  const canOpenOverview = steps.every(({ id }) => done[id]);
  const next = steps[steps.findIndex(({ id }) => id === step) + 1]?.id;
  const config = configBlock(account, {});
  const commands = setupCommands(account, {});
  const [connectError, setConnectError] = useState("");

  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    if (step !== "connect") return;
    const controller = new AbortController();
    let pending = false;
    async function poll() {
      if (pending) return;
      pending = true;
      try {
        await refresh();
        if (!controller.signal.aborted) setConnectError("");
      } catch (error) {
        if (!controller.signal.aborted) setConnectError((error as Error).message);
      } finally {
        pending = false;
      }
    }
    const stop = pollWhileVisible(document, () => void poll());
    return () => { controller.abort(); stop(); };
  }, [step, refresh]);

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
            }}><span role="img" className={done[id] ? "account-done" : "account-pending"} aria-label={done[id] ? "Done" : "Pending"}>{done[id] ? "✓" : "○"}</span>{label}</button>
          </li>)}</ol>
        </nav>
        <section className="account-card" aria-labelledby="setup-step-heading">
          <h2 ref={heading} id="setup-step-heading" tabIndex={-1}>{label}</h2>
          <div className="account-step">
            {account.connections.map(workspace => <WorkspaceSetup key={setupKey(workspace)} checkKey={setupKey(workspace)}
              workspace={workspace} created={created[workspace.id]}
              onCreated={team => {
                focusCreated.current = workspace.id;
                setCreated(previous => ({ ...previous, [workspace.id]: team }));
              }} confirmationRef={node => {
                if (node && focusCreated.current === workspace.id) {
                  node.focus();
                  focusCreated.current = null;
                }
              }} human={account.human} step={step} refresh={refresh} record={record} />)}
            {step === "statuses" && !account.connections.length && <p>Connect a workspace and select a team first.</p>}
            {step === "welcome" && <Intro />}
            {step === "name" && <NameForm human={account.human} refresh={refresh} next={() => setStep("workspaces")} />}
            {step === "workspaces" && <>
              {account.connections.map((workspace) => <article className="account-item" key={workspace.id}>
                <h3>{workspace.name}</h3><WorkspaceStatus workspace={workspace} />
              </article>)}
              <ConnectWorkspace refresh={refresh} page="setup" oauth={account.oauthAttach} />
            </>}
            {step === "setup" && <>
              <section>
                <h3>1. Add these settings to <code>~/.config/work-graph/config.json</code></h3>
                {account.connections.some(({ team }) => !team) && <p>Choose a team for each workspace before you run the setup commands.</p>}
                <Command text={config} label="Copy wg config" />
              </section>
              <section>
                <h3>2. Set up your Linear key</h3>
                <p><a href={readme + "#config"} target="_blank" rel="noreferrer">Set up a local Linear key</a> for each workspace on your computer so <code>wg</code> can work with its team. Set the environment variable or save the key in the file with permissions 600.</p>
                <ul className="account-key-locations">
                  {account.connections.map(({ id, name, workspace_id }) => {
                    const { env, file } = workspaceKeyLocation(workspace_id);
                    return <li key={id}>{name} <code>{env}</code> or <code>{file}</code></li>;
                  })}
                </ul>
              </section>
              <section><h3>3. Coordinator token</h3><TokenForm refresh={refresh} /></section>
              <section className="account-form">
                <h3>4. Then run these commands</h3>
                <p><a href={readme + "#install-the-skill"} target="_blank" rel="noreferrer">Read the installation instructions</a>.</p>
                <CopyAll text={installBlock(commands)} />
                <p>Paste the coordinator token when <code>wg login</code> asks for it.</p>
                {commands.map((command) => <Command key={command} text={command} label={`Copy ${command}`} />)}
              </section>
            </>}
            {step === "connect" && <>
              <p role="status">{account.onboarding.connected ? <><code>wg</code> is connected.</> :
                <>Waiting for <code>wg</code> to connect. Run <code>wg login</code> and <code>wg doctor</code> on your machine.</>}</p>
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
