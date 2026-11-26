//! Options accepted by the coordinator and machine commands.
use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "wg")]
pub struct Arguments {
    #[command(subcommand)]
    pub command: Operation,
}
#[derive(Subcommand)]
pub enum Operation {
    Next(Next),
    Watch(Next),
    Wake { dir: PathBuf },
    Health(Health),
    Autostart(Autostart),
    Agents(Agents),
    Tick(Tick),
}
#[derive(Args)]
pub struct Next {
    pub dir: PathBuf,
    #[arg(long)]
    pub wait: bool,
    #[arg(long, default_value = "300", allow_negative_numbers = true)]
    pub interval: f64,
    #[arg(long)]
    pub no_publish: bool,
    #[arg(long)]
    pub all: bool,
}
#[derive(Args)]
pub struct Health {
    pub dir: PathBuf,
    #[arg(long, group = "mode")]
    pub install: bool,
    #[arg(long, group = "mode")]
    pub uninstall: bool,
    #[arg(long, group = "mode")]
    pub due: bool,
    #[arg(long, group = "mode")]
    pub report: Option<PathBuf>,
}
#[derive(Args)]
pub struct Autostart {
    pub dir: PathBuf,
    #[arg(long, group = "mode")]
    pub install: bool,
    #[arg(long, group = "mode")]
    pub uninstall: bool,
    #[arg(long,value_parser=["codex","claude"])]
    pub agent: Option<String>,
    #[arg(long)]
    pub model: Option<String>,
    #[arg(long)]
    pub effort: Option<String>,
}
#[derive(Args)]
pub struct Tick {
    #[arg(long)]
    pub root: Vec<PathBuf>,
    #[arg(long,value_parser=["none","notify"])]
    pub channel: Option<String>,
    #[arg(long, group = "mode")]
    pub install: bool,
    #[arg(long, group = "mode")]
    pub uninstall: bool,
}
#[derive(Args)]
pub struct Agents {
    #[arg(long)]
    pub root: Vec<PathBuf>,
    #[arg(long, group = "mode")]
    pub install: bool,
    #[arg(long, group = "mode")]
    pub uninstall: bool,
    #[arg(long, group = "mode")]
    pub once: bool,
    #[arg(long, group = "mode")]
    pub wait: bool,
    #[arg(long)]
    pub approve: Option<String>,
}
