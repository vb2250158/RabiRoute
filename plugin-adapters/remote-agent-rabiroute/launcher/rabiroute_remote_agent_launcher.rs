#![windows_subsystem = "windows"]

use std::env;
use std::path::PathBuf;
use std::process::{Command, ExitCode};

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            eprintln!("RabiRoute Remote Agent launcher error: {message}");
            eprintln!("Please reinstall the complete release package.");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<u8, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let package_root: PathBuf = executable
        .parent()
        .ok_or_else(|| "Cannot resolve the package directory.".to_string())?
        .to_path_buf();
    let node = package_root.join("runtime").join("node.exe");
    let launcher = package_root.join("app").join("launcher.mjs");
    if !node.is_file() {
        return Err(format!("Bundled Node.js is missing: {}", node.display()));
    }
    if !launcher.is_file() {
        return Err(format!("Bridge launcher is missing: {}", launcher.display()));
    }

    let status = Command::new(node)
        .arg(launcher)
        .args(env::args_os().skip(1))
        .env("RABIROUTE_REMOTE_AGENT_PACKAGE_ROOT", &package_root)
        .current_dir(&package_root)
        .status()
        .map_err(|error| format!("Failed to start the bundled runtime: {error}"))?;
    Ok(status.code().unwrap_or(1).clamp(0, 255) as u8)
}
