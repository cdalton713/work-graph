//! Commands that operate on job worktrees and their test evidence.
use crate::linear::Installation;
use clap::{Parser, Subcommand};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

mod base;
mod evidence;
mod launch;
mod lifecycle;
mod verify;

#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Job,
}

#[derive(Subcommand)]
enum Job {
    Dispatch {
        dir: PathBuf,
        key: String,
        #[command(flatten)]
        agent: launch::Agent,
        #[arg(long, conflicts_with = "run")]
        worktree: Option<PathBuf>,
        #[arg(long)]
        run: bool,
    },
    Claim {
        dir: PathBuf,
        key: String,
        #[arg(value_parser=["dispatch","review","ci","threads","restack"])]
        job: String,
        #[command(flatten)]
        agent: launch::Agent,
        #[arg(long)]
        send: bool,
        #[arg(long)]
        takeover: bool,
        #[arg(long)]
        work_file: Option<PathBuf>,
    },
    Started {
        dir: PathBuf,
        key: String,
        #[arg(required = true)]
        fields: Vec<String>,
    },
    Done {
        dir: PathBuf,
        key: String,
        #[arg(long)]
        dispatch: Option<String>,
        #[arg(long)]
        failed: Option<String>,
        #[arg(long)]
        worktree: Option<PathBuf>,
    },
    Verify {
        dir: PathBuf,
        key: String,
    },
    Base {
        dir: PathBuf,
        #[arg(long)]
        phase: Option<String>,
    },
    Cleanup {
        dir: PathBuf,
        #[arg(long)]
        dry_run: bool,
    },
    Evidence {
        dir: PathBuf,
        key: String,
    },
}

pub fn command() -> ExitCode {
    match execute(Args::parse().command) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(2)
        }
    }
}

fn execute(job: Job) -> Result<u8, String> {
    let install = Installation::load()?;
    let dir = match &job {
        Job::Dispatch { dir, .. }
        | Job::Claim { dir, .. }
        | Job::Started { dir, .. }
        | Job::Done { dir, .. }
        | Job::Verify { dir, .. }
        | Job::Base { dir, .. }
        | Job::Cleanup { dir, .. }
        | Job::Evidence { dir, .. } => dir,
    };
    crate::page::refresh_workflow(&install, dir, false)?;
    let plan = install.config.load_plan(dir).map_err(|e| e.to_string())?;
    let ctx = lifecycle::Context {
        dir,
        install: &install,
        plan: &plan,
    };
    match &job {
        Job::Dispatch {
            key,
            agent,
            worktree,
            run,
            ..
        } => launch::dispatch(&ctx, key, agent, worktree.as_deref(), *run),
        Job::Claim {
            key,
            job,
            agent,
            send,
            takeover,
            work_file,
            ..
        } => launch::claim(
            &ctx,
            key,
            job,
            agent,
            *send,
            *takeover,
            work_file.as_deref(),
        ),
        Job::Started { key, fields, .. } => lifecycle::started(&ctx, key, fields),
        Job::Done {
            key,
            dispatch,
            failed,
            worktree,
            ..
        } => lifecycle::done(
            &ctx,
            key,
            dispatch.as_deref(),
            failed.as_deref(),
            worktree.as_deref(),
        ),
        Job::Verify { key, .. } => verify::run(&ctx, key, Path::new(".")),
        Job::Base { phase, .. } => base::run(dir, &install, &plan, phase.as_deref()),
        Job::Evidence { key, .. } => evidence::run(dir, &install, &plan, key),
        Job::Cleanup { dry_run, .. } => {
            if !dry_run {
                let km = crate::state::load_keymap(dir).map_err(|e| e.to_string())?;
                match crate::workflow::current_claims(&install, &plan, &km) {
                    Ok(Some(claims)) => {
                        let scope = plan["effort"]["workspace"]
                            .as_str()
                            .or_else(|| install.workspaces().first()?.get("id")?.as_str())
                            .ok_or("missing workspace")?;
                        for claim in claims["claims"].as_array().ok_or("missing claims")? {
                            if claim["mine"] == true {
                                crate::page::update_claim(
                                    &install,
                                    scope,
                                    &km["collab"],
                                    claim["node"].as_str().ok_or("missing claim key")?,
                                    None,
                                )?;
                            }
                        }
                    }
                    Err(e) => eprintln!("warn cleanup: could not list claims: {e}"),
                    Ok(None) => (),
                }
            }
            let kept = crate::workflow::cleanup_worktrees(dir, &install, &plan, None, *dry_run);
            if kept > 0 {
                println!("{kept} worktree(s) stay: see the warnings");
            }
            Ok(u8::from(kept > 0))
        }
    }
}

fn output(cmd: &mut Command) -> Result<String, String> {
    let r = cmd.output().map_err(|e| e.to_string())?;
    if !r.status.success() {
        return Err(String::from_utf8_lossy(&r.stderr).trim().to_owned());
    }
    Ok(String::from_utf8_lossy(&r.stdout).trim().to_owned())
}
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    output(Command::new("git").current_dir(dir).args(args))
}
fn list(v: &Value) -> Result<&Vec<Value>, String> {
    v.as_array().ok_or_else(|| "expected an array".to_string())
}
mod worktree;

fn phase_matches(key: &Value, text: &str) -> bool {
    key.as_str() == Some(text) || key.as_number().is_some_and(|n| n.to_string() == text)
}
