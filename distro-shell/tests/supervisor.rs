use liskov_shell::{supervise, Logger, StartupConfig};
use std::fs;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// Run the real supervisor in an isolated process, with a fake shell and short
// timeout/heartbeat. Environment changes never race with the host test runner.
#[test]
#[ignore]
fn supervisor_fixture() {
    let config = StartupConfig {
        shell: std::env::var_os("LISKOV_SHELL_TEST_SHELL").unwrap().into(),
        script_path: std::env::var_os("LISKOV_SHELL_TEST_SCRIPT").unwrap().into(),
        timeout: Duration::from_millis(100),
    };
    let log: Logger = Arc::new(|line| {
        println!("{line}");
        if line == "shell.ready" {
            println!(
                "fixture.preload-present={}",
                std::env::var_os("LD_PRELOAD").is_some()
            );
            println!("fixture.tmpdir={}", std::env::var("TMPDIR").unwrap());
        }
    });
    supervise(&config, Duration::from_millis(10), log);
}

struct Fixture {
    root: PathBuf,
    child: Child,
    output: mpsc::Receiver<String>,
    lines: Vec<String>,
}

impl Fixture {
    fn new(script: Option<&str>, missing_shell: bool, bad_script_path: bool) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("liskov-shell-{}-{unique}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let shell = root.join("fake-shell");
        fs::write(&shell, "#!/bin/sh\nprintf 'tmpdir=%s\\n' \"$TMPDIR\"\nprintf 'preload=%s\\n' \"${LD_PRELOAD+present}\"\nprintf 'fake-shell-args=%s\\n' \"$#\"\nexec /bin/sh \"$1\"\n").unwrap();
        fs::set_permissions(&shell, fs::Permissions::from_mode(0o700)).unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--ignored", "--exact", "supervisor_fixture", "--nocapture"])
            .env(
                "LISKOV_SHELL_TEST_SHELL",
                if missing_shell {
                    root.join("missing")
                } else {
                    shell
                },
            )
            .env(
                "LISKOV_SHELL_TEST_SCRIPT",
                if bad_script_path {
                    root.join("missing/startup.sh")
                } else {
                    root.join("startup.sh")
                },
            )
            .env("LISKOV_SHELL_TEST_RELEASE", root.join("release"))
            .env("LISKOV_SHELL_TEST_RUNNING", root.join("running"))
            .env("LD_PRELOAD", "")
            .env("TMPDIR", "/wrong-inherited-tmpdir")
            .stdout(Stdio::piped());
        match script {
            Some(script) => {
                command.env("LISKOV_SHELL_STARTUP", script);
            }
            None => {
                command.env_remove("LISKOV_SHELL_STARTUP");
            }
        }
        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if send.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        Self {
            root,
            child,
            output,
            lines: Vec::new(),
        }
    }

    fn until(&mut self, expected: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.lines.iter().any(|line| line == expected) {
            let line = self
                .output
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|error| {
                    panic!("waiting for {expected}: {error}; {:?}", self.lines)
                });
            self.lines.push(line);
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::write(self.root.join("release"), "").unwrap();
        // Let a timed-out script finish before removing its temporary files.
        std::thread::sleep(Duration::from_millis(30));
        self.child.kill().unwrap();
        self.child.wait().unwrap();
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn failure_streams_both_outputs_and_preserves_parent_environment() {
    let mut fixture = Fixture::new(
        Some("printf 'hello\\n'; printf 'error\\n' >&2; exit 3"),
        false,
        false,
    );
    fixture.until("shell.startup.exit=3");
    fixture.until("shell.ready");
    fixture.until("shell.startup hello");
    fixture.until("shell.startup error");
    fixture.until("shell.startup tmpdir=/tmp");
    fixture.until("shell.startup preload=");
    fixture.until("shell.startup fake-shell-args=1");
    fixture.until("fixture.preload-present=true");
    fixture.until("fixture.tmpdir=/tmp");
    fixture.until("shell.heartbeat");
    let exit = fixture
        .lines
        .iter()
        .position(|line| line == "shell.startup.exit=3")
        .unwrap();
    let ready = fixture
        .lines
        .iter()
        .position(|line| line == "shell.ready")
        .unwrap();
    assert!(exit < ready);
    assert_eq!(
        fs::read_to_string(fixture.root.join("startup.sh")).unwrap(),
        "printf 'hello\\n'; printf 'error\\n' >&2; exit 3"
    );
}

#[test]
fn unset_and_empty_startup_are_skipped() {
    for script in [None, Some("")] {
        let mut fixture = Fixture::new(script, true, false);
        fixture.until("shell.ready");
        fixture.until("shell.heartbeat");
        assert!(!fixture.root.join("startup.sh").exists());
        assert!(!fixture
            .lines
            .iter()
            .any(|line| line.starts_with("shell.startup")));
    }
}

#[test]
fn timeout_reaches_ready_leaves_script_alive_and_logs_its_later_exit() {
    let mut fixture = Fixture::new(Some("echo running > \"$LISKOV_SHELL_TEST_RUNNING\"; while [ ! -f \"$LISKOV_SHELL_TEST_RELEASE\" ]; do sleep 0.01; done; echo finished"), false, false);
    fixture.until("shell.startup.timeout");
    fixture.until("shell.ready");
    fixture.until("shell.heartbeat");
    assert!(fixture.root.join("running").exists());
    assert!(!fixture
        .lines
        .iter()
        .any(|line| line.starts_with("shell.startup.exit=")));
    fs::write(fixture.root.join("release"), "").unwrap();
    fixture.until("shell.startup finished");
    fixture.until("shell.startup.exit=0");
    assert!(fixture.child.try_wait().unwrap().is_none());
}

#[test]
fn write_and_spawn_errors_still_reach_ready() {
    for (missing_shell, bad_script_path, expected) in
        [(true, false, "spawn"), (false, true, "write")]
    {
        let mut fixture = Fixture::new(Some("exit 0"), missing_shell, bad_script_path);
        fixture.until("shell.ready");
        fixture.until("shell.heartbeat");
        assert!(fixture
            .lines
            .iter()
            .any(|line| line.starts_with(&format!("shell.startup.error={expected} "))));
    }
}
