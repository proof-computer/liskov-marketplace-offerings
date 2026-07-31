use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::path::Path;
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const FAIL_ONCE_ENV: &str = "LISKOV_HELLO_CANARY_FAIL_ONCE_FILE";

fn main() -> ExitCode {
    if let Some(marker) = std::env::var_os(FAIL_ONCE_ENV) {
        match claim_fail_once(Path::new(&marker)) {
            Ok(true) => {
                println!("rust-hello-world canary: intentional first-attempt failure");
                return ExitCode::from(42);
            }
            Ok(false) => {}
            Err(()) => {
                eprintln!("rust-hello-world: invalid canary fail-once marker");
                return ExitCode::from(70);
            }
        }
    }

    println!("Hello from Rust on Liskov.");
    let mut sequence = 0_u64;
    loop {
        println!(
            "rust-hello-world heartbeat sequence={sequence} unixTimeMs={}",
            unix_time_ms()
        );
        let _ = std::io::stdout().flush();
        sequence = sequence.saturating_add(1);
        thread::sleep(Duration::from_secs(10));
    }
}

fn claim_fail_once(path: &Path) -> Result<bool, ()> {
    if !path.is_absolute() {
        return Err(());
    }
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            file.write_all(b"failed-once\n").map_err(|_| ())?;
            file.flush().map_err(|_| ())?;
            Ok(true)
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(false),
        Err(_) => Err(()),
    }
}

fn unix_time_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fail_once_is_absolute_and_atomic() {
        let path =
            std::env::temp_dir().join(format!("rust-hello-world-fail-once-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        assert_eq!(claim_fail_once(&path), Ok(true));
        assert_eq!(claim_fail_once(&path), Ok(false));
        std::fs::remove_file(path).unwrap();
        assert_eq!(claim_fail_once(Path::new("relative")), Err(()));
    }
}
