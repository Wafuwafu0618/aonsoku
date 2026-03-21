use std::io::{self, BufRead, BufReader};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

mod audio;
mod commands;
mod decoder;
mod engine;
mod error;
mod oversampling;
mod protocol;
mod runtime;

use commands::handle_command;
use engine::{run_tick, EngineState, TICK_INTERVAL_MS};
use protocol::SidecarRequest;
use runtime::AudioRuntime;

enum InputMessage {
    Line(String),
    Eof,
}

fn spawn_stdin_reader() -> Receiver<InputMessage> {
    let (sender, receiver) = mpsc::channel::<InputMessage>();

    thread::spawn(move || {
        let stdin = io::stdin();
        let reader = BufReader::new(stdin.lock());

        for line_result in reader.lines() {
            let line = match line_result {
                Ok(value) => value,
                Err(_) => continue,
            };

            if sender.send(InputMessage::Line(line)).is_err() {
                return;
            }
        }

        let _ = sender.send(InputMessage::Eof);
    });

    receiver
}

fn main() -> io::Result<()> {
    let receiver = spawn_stdin_reader();
    let mut state = EngineState::default();
    let mut runtime = AudioRuntime::default();

    loop {
        match receiver.recv_timeout(Duration::from_millis(TICK_INTERVAL_MS)) {
            Ok(InputMessage::Line(line)) => {
                if line.trim().is_empty() {
                    continue;
                }

                let request = match serde_json::from_str::<SidecarRequest>(&line) {
                    Ok(value) => value,
                    Err(_) => continue,
                };

                if request.kind != "request" {
                    continue;
                }

                handle_command(request, &mut state, &mut runtime)?;
            }
            Ok(InputMessage::Eof) => break,
            Err(RecvTimeoutError::Timeout) => {
                run_tick(&mut state, &mut runtime)?;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    runtime.shutdown();
    Ok(())
}
