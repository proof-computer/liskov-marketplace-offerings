use std::io::Write;
use std::thread;
use std::time::Duration;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const HEARTBEAT_LIMIT: u64 = 360;

fn main() {
    println!("managed-runtime-ssh-canary: customer process started");
    let _ = std::io::stdout().flush();

    for sequence in 0..HEARTBEAT_LIMIT {
        println!("managed-runtime-ssh-canary: heartbeat sequence={sequence}");
        let _ = std::io::stdout().flush();
        thread::sleep(HEARTBEAT_INTERVAL);
    }

    println!("managed-runtime-ssh-canary: customer process completed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_is_exactly_three_hours() {
        assert_eq!(HEARTBEAT_INTERVAL.as_secs() * HEARTBEAT_LIMIT, 10_800);
    }
}
