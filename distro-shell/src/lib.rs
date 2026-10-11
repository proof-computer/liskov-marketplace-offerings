use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

pub type Logger = Arc<dyn Fn(&str) + Send + Sync>;

/// Own the environment setup and keep the box reachable regardless of startup.
pub fn supervise(config: &StartupConfig, heartbeat: Duration, log: Logger) -> ! {
    if let Err(error) = fs::create_dir_all("/tmp") {
        log(&format!("shell.startup.error=tmpdir {error}"));
    }
    // Called before creating threads; do not remove the parent's LD_PRELOAD.
    std::env::set_var("TMPDIR", "/tmp");
    run_startup(
        std::env::var_os("LISKOV_SHELL_STARTUP").as_deref(),
        config,
        log.clone(),
    );
    log("shell.ready");
    loop {
        thread::sleep(heartbeat);
        log("shell.heartbeat");
    }
}

/// Runtime defaults; paths and timeout can be replaced by host tests.
pub struct StartupConfig {
    pub shell: PathBuf,
    pub script_path: PathBuf,
    pub timeout: Duration,
}

impl Default for StartupConfig {
    fn default() -> Self {
        Self {
            shell: "/bin/sh".into(),
            script_path: "/tmp/liskov-shell-startup.sh".into(),
            timeout: Duration::from_secs(30 * 60),
        }
    }
}

/// Wait at most the configured timeout. The waiter reaps the child and logs
/// its eventual exit even after an overrun; output readers never gate readiness.
pub fn run_startup(script: Option<&OsStr>, config: &StartupConfig, log: Logger) {
    let Some(script) = script.filter(|value| !value.is_empty()) else {
        return;
    };
    if let Err(error) = fs::write(&config.script_path, script.as_bytes()) {
        log(&format!("shell.startup.error=write {error}"));
        return;
    }
    let mut child = match Command::new(&config.shell)
        .arg(&config.script_path)
        .env_remove("LD_PRELOAD")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            log(&format!("shell.startup.error=spawn {error}"));
            return;
        }
    };
    // Both streams go to stdout with the same startup prefix. A descendant
    // retaining a pipe cannot hold up the main supervisor.
    stream_output(child.stdout.take().expect("piped stdout"), log.clone());
    stream_output(child.stderr.take().expect("piped stderr"), log.clone());
    let (finished, wait) = mpsc::channel();
    let exit_log = log.clone();
    thread::spawn(move || {
        match child.wait() {
            Ok(status) => {
                let code = status
                    .code()
                    .unwrap_or_else(|| 128 + status.signal().unwrap_or(0));
                exit_log(&format!("shell.startup.exit={code}"));
            }
            Err(error) => exit_log(&format!("shell.startup.error=wait {error}")),
        }
        // The supervisor may already have moved on after the deadline.
        let _ = finished.send(());
    });
    match wait.recv_timeout(config.timeout) {
        Ok(()) => {}
        Err(mpsc::RecvTimeoutError::Timeout) => log("shell.startup.timeout"),
        Err(mpsc::RecvTimeoutError::Disconnected) => log("shell.startup.error=waiter-disconnected"),
    }
}

fn stream_output(mut stream: impl Read + Send + 'static, log: Logger) {
    thread::spawn(move || {
        let mut buffer = [0; 4096];
        let mut line = Vec::new();
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    for byte in &buffer[..length] {
                        line.push(*byte);
                        // Bound memory for scripts that never write a newline.
                        if *byte == b'\n' || line.len() == buffer.len() {
                            log(&format!(
                                "shell.startup {}",
                                String::from_utf8_lossy(&line).trim_end_matches('\n')
                            ));
                            line.clear();
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    log(&format!("shell.startup.error=output {error}"));
                    break;
                }
            }
        }
        if !line.is_empty() {
            log(&format!("shell.startup {}", String::from_utf8_lossy(&line)));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn missing_and_empty_scripts_do_not_write_or_spawn() {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let captured = lines.clone();
        let log: Logger = Arc::new(move |line| captured.lock().unwrap().push(line.to_owned()));
        let config = StartupConfig {
            shell: "/does-not-exist".into(),
            script_path: "/does-not-exist/startup.sh".into(),
            timeout: Duration::ZERO,
        };
        run_startup(None, &config, log.clone());
        run_startup(Some(OsStr::new("")), &config, log);
        assert!(lines.lock().unwrap().is_empty());
    }
}
