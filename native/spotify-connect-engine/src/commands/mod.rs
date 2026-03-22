use std::io;

use crate::protocol::{
    command_result_ok_value, emit_command_error, emit_event, emit_named_event, emit_response_ok,
    parse_params, parse_params_or_default, InitializeParams, PlayUriParams, SetActiveDeviceParams,
    SidecarRequest, SpotifyConnectEvent, SpotifyConnectInitializeResult,
};
use crate::runtime::SpotifyRuntimeState;

pub fn handle_command(request: SidecarRequest, state: &mut SpotifyRuntimeState) -> io::Result<()> {
    let command = request.command;
    let request_id = request.id;
    let params = request.params;

    match command.as_str() {
        "initialize" => match parse_params_or_default::<InitializeParams>(params) {
            Ok(params) => {
                let is_first_initialize = state.initialize(params);
                emit_named_event(
                    "ready",
                    Some("Spotify Connect sidecar initialized.".to_string()),
                )?;

                let init_result = SpotifyConnectInitializeResult {
                    ok: true,
                    version: env!("CARGO_PKG_VERSION").to_string(),
                    engine: "spotify-connect-sidecar".to_string(),
                    message: if is_first_initialize {
                        "Spotify Connect sidecar initialized.".to_string()
                    } else {
                        "Spotify Connect sidecar already initialized.".to_string()
                    },
                    receiver_running: state.receiver_running,
                };

                emit_response_ok(
                    &request_id,
                    Some(
                        serde_json::to_value(init_result)
                            .unwrap_or_else(|_| serde_json::json!({ "ok": true })),
                    ),
                )?;
            }
            Err(message) => {
                emit_command_error(&request_id, "invalid-params", &message, None)?;
            }
        },
        "startReceiver" => {
            if !state.initialized {
                emit_command_error(
                    &request_id,
                    "not-initialized",
                    "Call initialize before startReceiver.",
                    None,
                )?;
                return Ok(());
            }

            if let Err(error) = state.start_receiver() {
                emit_command_error(
                    &request_id,
                    &error.code,
                    &error.message,
                    error.details,
                )?;
                return Ok(());
            }

            emit_event(SpotifyConnectEvent {
                event_type: "receiverStarted".to_string(),
                receiver_running: Some(true),
                session_connected: Some(state.session_connected),
                is_playing: Some(state.is_playing),
                current_time_seconds: Some(state.current_time_seconds),
                duration_seconds: Some(state.duration_seconds),
                volume: Some(state.volume),
                active_track: state.active_track.clone(),
                message: Some("Spotify Connect receiver process started.".to_string()),
                error: None,
            })?;
            emit_response_ok(&request_id, Some(command_result_ok_value()))?;
        }
        "status" => {
            emit_response_ok(
                &request_id,
                Some(
                    serde_json::to_value(state.status())
                        .unwrap_or_else(|_| serde_json::json!({ "ok": false })),
                ),
            )?;
        }
        "listDevices" => match state.list_devices() {
            Ok(result) => {
                emit_response_ok(
                    &request_id,
                    Some(
                        serde_json::to_value(result)
                            .unwrap_or_else(|_| serde_json::json!({ "ok": false, "devices": [] })),
                    ),
                )?;
            }
            Err(error) => {
                emit_command_error(
                    &request_id,
                    &error.code,
                    &error.message,
                    error.details,
                )?;
            }
        },
        "setActiveDevice" => match parse_params::<SetActiveDeviceParams>(params) {
            Ok(parsed) => {
                if let Err(error) = state.set_active_device(parsed) {
                    emit_command_error(
                        &request_id,
                        &error.code,
                        &error.message,
                        error.details,
                    )?;
                    return Ok(());
                }
                emit_response_ok(&request_id, Some(command_result_ok_value()))?;
            }
            Err(message) => {
                emit_command_error(&request_id, "invalid-params", &message, None)?;
            }
        },
        "playUri" => match parse_params::<PlayUriParams>(params) {
            Ok(parsed) => {
                if let Err(error) = state.play_uri(parsed) {
                    emit_command_error(
                        &request_id,
                        &error.code,
                        &error.message,
                        error.details,
                    )?;
                    return Ok(());
                }
                emit_response_ok(&request_id, Some(command_result_ok_value()))?;
            }
            Err(message) => {
                emit_command_error(&request_id, "invalid-params", &message, None)?;
            }
        },
        "dispose" => {
            let was_receiver_running = state.receiver_running;
            if let Err(error) = state.dispose() {
                emit_command_error(
                    &request_id,
                    &error.code,
                    &error.message,
                    error.details,
                )?;
                return Ok(());
            }

            if was_receiver_running {
                emit_event(SpotifyConnectEvent {
                    event_type: "receiverStopped".to_string(),
                    receiver_running: Some(false),
                    session_connected: Some(false),
                    is_playing: Some(false),
                    current_time_seconds: Some(0.0),
                    duration_seconds: Some(0.0),
                    volume: Some(state.volume),
                    active_track: None,
                    message: Some("Spotify Connect receiver stopped.".to_string()),
                    error: None,
                })?;
            }
            emit_response_ok(&request_id, Some(command_result_ok_value()))?;
        }
        _ => {
            emit_command_error(
                &request_id,
                "unknown-command",
                "Unsupported Spotify Connect sidecar command.",
                Some(serde_json::json!({
                    "command": command,
                    "supportedCommands": [
                        "initialize",
                        "startReceiver",
                        "status",
                        "listDevices",
                        "setActiveDevice",
                        "playUri",
                        "dispose"
                    ]
                })),
            )?;
        }
    }

    Ok(())
}
