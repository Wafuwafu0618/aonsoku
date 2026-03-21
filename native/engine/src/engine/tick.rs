use std::io;
use std::time::Instant;

use crate::protocol::{emit_command_error, emit_simple_event};
use crate::runtime::AudioRuntime;

use super::{EngineState, OutputMode, PlaybackState};

pub const TICK_INTERVAL_MS: u64 = 200;

pub fn ensure_output_mode_supported(state: &EngineState, request_id: &str) -> io::Result<bool> {
    if state.output_mode != OutputMode::Asio {
        return Ok(true);
    }

    emit_command_error(
        request_id,
        "unsupported-output-mode",
        "Current build does not support ASIO output mode yet.",
        Some(serde_json::json!({ "mode": state.output_mode.as_str() })),
    )?;

    Ok(false)
}

pub fn run_tick(state: &mut EngineState, runtime: &mut AudioRuntime) -> io::Result<()> {
    if !state.is_playing() {
        return Ok(());
    }

    let should_advance_clock = runtime.should_advance_playback_clock(state.output_mode);
    let ended_by_clock = if should_advance_clock {
        state.advance_clock()
    } else {
        // Keep the monotonic baseline fresh so startup/prefill time does not
        // jump the UI position once actual audio rendering begins.
        state.last_tick_instant = Some(Instant::now());
        false
    };
    let ended_by_sink = runtime.is_sink_empty();

    emit_simple_event(
        "timeupdate",
        Some(state.current_time_seconds),
        Some(state.duration_seconds),
    )?;

    if ended_by_clock || ended_by_sink {
        if state.playback_state != PlaybackState::Ended {
            state.playback_state = PlaybackState::Ended;
            state.current_time_seconds = state.duration_seconds;
            state.last_tick_instant = None;
        }

        emit_simple_event(
            "ended",
            Some(state.current_time_seconds),
            Some(state.duration_seconds),
        )?;
    }

    Ok(())
}
