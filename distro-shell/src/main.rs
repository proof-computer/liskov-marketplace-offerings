use liskov_shell::{supervise, Logger, StartupConfig};
use std::sync::Arc;
use std::time::Duration;

fn main() {
    let log: Logger = Arc::new(|line| println!("{line}"));
    supervise(&StartupConfig::default(), Duration::from_secs(60), log);
}
