use serde::{Deserialize, Serialize};
use serde_json::Value;

fn string_or_number<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;

    let value = Value::deserialize(deserializer)?;
    match value {
        Value::String(s) => Ok(s),
        Value::Number(n) => Ok(n.to_string()),
        _ => Err(D::Error::custom("expected string or number for id")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarRequest {
    pub kind: String,
    #[serde(deserialize_with = "string_or_number")]
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarResponse {
    pub kind: String,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SpotifyConnectErrorPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyConnectErrorPayload {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarEventEnvelope {
    pub kind: String,
    pub event: SpotifyConnectEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyConnectEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receiver_running: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_connected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_playing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_time_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_track: Option<SpotifyConnectTrackInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SpotifyConnectErrorPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyConnectTrackInfo {
    pub spotify_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artists: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_art_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub cache_dir: Option<String>,
    #[serde(default)]
    pub zeroconf_port: Option<u16>,
    #[serde(default)]
    pub librespot_path: Option<String>,
    #[serde(default)]
    pub access_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyConnectInitializeResult {
    pub ok: bool,
    pub version: String,
    pub engine: String,
    pub message: String,
    pub receiver_running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyConnectStatusResult {
    pub ok: bool,
    pub initialized: bool,
    pub receiver_running: bool,
    pub session_connected: bool,
    pub is_playing: bool,
    pub current_time_seconds: f64,
    pub duration_seconds: f64,
    pub volume: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_track: Option<SpotifyConnectTrackInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SpotifyConnectErrorPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyConnectDeviceInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub device_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_restricted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_private_session: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_volume: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyConnectListDevicesResult {
    pub ok: bool,
    pub devices: Vec<SpotifyConnectDeviceInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SpotifyConnectErrorPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetActiveDeviceParams {
    pub device_id: String,
    #[serde(default)]
    pub transfer_playback: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayUriParams {
    pub spotify_uri: String,
    #[serde(default)]
    pub start_at_seconds: Option<f64>,
    #[serde(default)]
    pub device_id: Option<String>,
}
