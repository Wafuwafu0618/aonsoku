use std::io::{self, BufRead, BufReader};

mod commands;
mod protocol;
mod runtime;

use commands::handle_command;
use protocol::SidecarRequest;
use runtime::SpotifyRuntimeState;

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let reader = BufReader::new(stdin.lock());
    let mut state = SpotifyRuntimeState::new();

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(value) => value,
            Err(_) => continue,
        };

        if line.trim().is_empty() {
            continue;
        }

        let request = match serde_json::from_str::<SidecarRequest>(&line) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("[SpotifyConnectSidecar] invalid request JSON: {}", error);
                continue;
            }
        };

        if request.kind != "request" {
            continue;
        }

        handle_command(request, &mut state)?;
    }

    Ok(())
}
