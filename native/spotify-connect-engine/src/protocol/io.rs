use std::io::{self, Write};

use crate::protocol::{
    SidecarEventEnvelope, SidecarResponse, SpotifyConnectErrorPayload, SpotifyConnectEvent,
};

pub fn write_json_line<T: serde::Serialize>(value: &T) -> io::Result<()> {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    serde_json::to_writer(&mut handle, value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    handle.write_all(b"\n")?;
    handle.flush()?;
    Ok(())
}

pub fn emit_event(event: SpotifyConnectEvent) -> io::Result<()> {
    write_json_line(&SidecarEventEnvelope {
        kind: "event".to_string(),
        event,
    })
}

pub fn emit_named_event(event_type: &str, message: Option<String>) -> io::Result<()> {
    emit_event(SpotifyConnectEvent {
        event_type: event_type.to_string(),
        receiver_running: None,
        session_connected: None,
        is_playing: None,
        current_time_seconds: None,
        duration_seconds: None,
        volume: None,
        active_track: None,
        message,
        error: None,
    })
}

pub fn emit_error_event(
    code: &str,
    message: &str,
    details: Option<serde_json::Value>,
) -> io::Result<()> {
    emit_event(SpotifyConnectEvent {
        event_type: "error".to_string(),
        receiver_running: None,
        session_connected: None,
        is_playing: None,
        current_time_seconds: None,
        duration_seconds: None,
        volume: None,
        active_track: None,
        message: Some(message.to_string()),
        error: Some(SpotifyConnectErrorPayload {
            code: code.to_string(),
            message: message.to_string(),
            details,
        }),
    })
}

pub fn emit_response_ok(id: &str, result: Option<serde_json::Value>) -> io::Result<()> {
    write_json_line(&SidecarResponse {
        kind: "response".to_string(),
        id: id.to_string(),
        ok: true,
        result,
        error: None,
    })
}

pub fn emit_response_error(
    id: &str,
    code: &str,
    message: &str,
    details: Option<serde_json::Value>,
) -> io::Result<()> {
    write_json_line(&SidecarResponse {
        kind: "response".to_string(),
        id: id.to_string(),
        ok: false,
        result: None,
        error: Some(SpotifyConnectErrorPayload {
            code: code.to_string(),
            message: message.to_string(),
            details,
        }),
    })
}

pub fn emit_command_error(
    id: &str,
    code: &str,
    message: &str,
    details: Option<serde_json::Value>,
) -> io::Result<()> {
    emit_error_event(code, message, details.clone())?;
    emit_response_error(id, code, message, details)
}

pub fn parse_params<T: for<'de> serde::Deserialize<'de>>(
    params: Option<serde_json::Value>,
) -> Result<T, String> {
    let payload = params.ok_or_else(|| "Missing params".to_string())?;
    serde_json::from_value(payload).map_err(|error| error.to_string())
}

pub fn parse_params_or_default<T: for<'de> serde::Deserialize<'de> + Default>(
    params: Option<serde_json::Value>,
) -> Result<T, String> {
    match params {
        Some(payload) => serde_json::from_value(payload).map_err(|error| error.to_string()),
        None => Ok(T::default()),
    }
}

pub fn command_result_ok_value() -> serde_json::Value {
    serde_json::json!({ "ok": true })
}
