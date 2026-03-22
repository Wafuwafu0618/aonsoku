use std::env;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use reqwest::blocking::Client;
use serde_json::Value;

use crate::protocol::{
    emit_event, InitializeParams, PlayUriParams, SetActiveDeviceParams, SpotifyConnectDeviceInfo,
    SpotifyConnectErrorPayload, SpotifyConnectEvent, SpotifyConnectListDevicesResult,
    SpotifyConnectStatusResult, SpotifyConnectTrackInfo,
};

const DEFAULT_DEVICE_NAME: &str = "Aonsoku Spotify Connect";
const SPOTIFY_API_BASE_URL: &str = "https://api.spotify.com/v1";

#[derive(Default)]
struct LibrespotSignals {
    session_connected: bool,
}

pub struct SpotifyRuntimeState {
    pub initialized: bool,
    pub receiver_running: bool,
    pub session_connected: bool,
    pub is_playing: bool,
    pub current_time_seconds: f64,
    pub duration_seconds: f64,
    pub volume: f64,
    pub active_track: Option<SpotifyConnectTrackInfo>,
    pub device_name: Option<String>,
    pub cache_dir: Option<String>,
    pub zeroconf_port: Option<u16>,
    pub librespot_path: Option<String>,
    pub active_device_id: Option<String>,
    pub controller_devices: Vec<SpotifyConnectDeviceInfo>,
    pub access_token: Option<String>,
    librespot_child: Option<Child>,
    librespot_signals: Arc<Mutex<LibrespotSignals>>,
    http_client: Client,
}

impl SpotifyRuntimeState {
    pub fn new() -> Self {
        let http_client = Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            initialized: false,
            receiver_running: false,
            session_connected: false,
            is_playing: false,
            current_time_seconds: 0.0,
            duration_seconds: 0.0,
            volume: 1.0,
            active_track: None,
            device_name: None,
            cache_dir: None,
            zeroconf_port: None,
            librespot_path: None,
            active_device_id: None,
            controller_devices: Vec::new(),
            access_token: None,
            librespot_child: None,
            librespot_signals: Arc::new(Mutex::new(LibrespotSignals::default())),
            http_client,
        }
    }

    pub fn initialize(&mut self, params: InitializeParams) -> bool {
        let is_first_initialize = !self.initialized;
        self.initialized = true;
        self.device_name = params.device_name;
        self.cache_dir = params.cache_dir;
        self.zeroconf_port = params.zeroconf_port;
        self.librespot_path = params.librespot_path;
        if let Some(access_token) = params.access_token {
            let trimmed = access_token.trim().to_string();
            self.access_token = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
        }
        is_first_initialize
    }

    pub fn list_devices(&mut self) -> Result<SpotifyConnectListDevicesResult, SpotifyConnectErrorPayload> {
        let token = self.require_access_token()?;

        let response = self
            .http_client
            .get(format!("{SPOTIFY_API_BASE_URL}/me/player/devices"))
            .bearer_auth(token)
            .send()
            .map_err(|error| SpotifyConnectErrorPayload {
                code: "spotify-api-network-error".to_string(),
                message: "Failed to call Spotify devices API.".to_string(),
                details: Some(serde_json::json!({
                    "error": error.to_string(),
                    "endpoint": "/me/player/devices"
                })),
            })?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(SpotifyConnectErrorPayload {
                code: "spotify-api-list-devices-failed".to_string(),
                message: "Spotify devices API returned an error.".to_string(),
                details: Some(serde_json::json!({
                    "status": status.as_u16(),
                    "body": body
                })),
            });
        }

        let payload: Value = response.json().map_err(|error| SpotifyConnectErrorPayload {
            code: "spotify-api-invalid-json".to_string(),
            message: "Failed to parse Spotify devices response.".to_string(),
            details: Some(serde_json::json!({
                "error": error.to_string(),
                "endpoint": "/me/player/devices"
            })),
        })?;

        let mut devices = Vec::new();
        let mut active_device_id: Option<String> = None;

        if let Some(raw_devices) = payload.get("devices").and_then(Value::as_array) {
            for raw_device in raw_devices {
                let Some(device_id) = raw_device.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let name = raw_device
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown Device")
                    .to_string();
                let is_active = raw_device.get("is_active").and_then(Value::as_bool);
                if is_active == Some(true) {
                    active_device_id = Some(device_id.to_string());
                }

                let volume_percent = raw_device
                    .get("volume_percent")
                    .and_then(Value::as_u64)
                    .and_then(|value| u8::try_from(value).ok());

                devices.push(SpotifyConnectDeviceInfo {
                    id: device_id.to_string(),
                    name,
                    device_type: raw_device
                        .get("type")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    is_active,
                    is_restricted: raw_device.get("is_restricted").and_then(Value::as_bool),
                    volume_percent,
                    is_private_session: raw_device
                        .get("is_private_session")
                        .and_then(Value::as_bool),
                    supports_volume: raw_device.get("supports_volume").and_then(Value::as_bool),
                });
            }
        }

        self.controller_devices = devices.clone();
        self.active_device_id = active_device_id.clone();

        let _ = emit_event(SpotifyConnectEvent {
            event_type: "deviceListChanged".to_string(),
            receiver_running: Some(self.receiver_running),
            session_connected: Some(self.session_connected),
            is_playing: Some(self.is_playing),
            current_time_seconds: Some(self.current_time_seconds),
            duration_seconds: Some(self.duration_seconds),
            volume: Some(self.volume),
            active_track: self.active_track.clone(),
            message: Some(format!("Fetched {} Spotify Connect devices.", self.controller_devices.len())),
            error: None,
        });

        Ok(SpotifyConnectListDevicesResult {
            ok: true,
            devices,
            active_device_id,
            error: None,
        })
    }

    pub fn set_active_device(
        &mut self,
        params: SetActiveDeviceParams,
    ) -> Result<(), SpotifyConnectErrorPayload> {
        let device_id = params.device_id.trim();
        if device_id.is_empty() {
            return Err(SpotifyConnectErrorPayload {
                code: "invalid-device-id".to_string(),
                message: "deviceId must be a non-empty string.".to_string(),
                details: None,
            });
        }

        self.send_spotify_put(
            "/me/player",
            None,
            serde_json::json!({
                "device_ids": [device_id],
                "play": params.transfer_playback.unwrap_or(false)
            }),
            "spotify-api-transfer-failed",
            "Failed to transfer playback to selected device.",
        )?;

        self.active_device_id = Some(device_id.to_string());
        self.sync_active_device_flags();

        let _ = emit_event(SpotifyConnectEvent {
            event_type: "deviceListChanged".to_string(),
            receiver_running: Some(self.receiver_running),
            session_connected: Some(self.session_connected),
            is_playing: Some(self.is_playing),
            current_time_seconds: Some(self.current_time_seconds),
            duration_seconds: Some(self.duration_seconds),
            volume: Some(self.volume),
            active_track: self.active_track.clone(),
            message: Some(format!("Active Spotify device changed: {}", device_id)),
            error: None,
        });

        Ok(())
    }

    pub fn play_uri(&mut self, params: PlayUriParams) -> Result<(), SpotifyConnectErrorPayload> {
        let spotify_uri = params.spotify_uri.trim();
        if spotify_uri.is_empty() || !spotify_uri.starts_with("spotify:") {
            return Err(SpotifyConnectErrorPayload {
                code: "invalid-spotify-uri".to_string(),
                message: "spotifyUri must be a valid spotify: URI.".to_string(),
                details: Some(serde_json::json!({
                    "spotifyUri": params.spotify_uri
                })),
            });
        }

        let query_device_id = params
            .device_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.active_device_id.clone());

        let mut body = serde_json::json!({
            "uris": [spotify_uri]
        });

        if let Some(start_at_seconds) = params.start_at_seconds {
            let clamped = if start_at_seconds.is_sign_negative() {
                0.0
            } else {
                start_at_seconds
            };
            let position_ms = (clamped * 1000.0).round() as u64;
            body["position_ms"] = serde_json::json!(position_ms);
            self.current_time_seconds = clamped;
        }

        self.send_spotify_put(
            "/me/player/play",
            query_device_id.as_deref(),
            body,
            "spotify-api-play-failed",
            "Failed to start Spotify playback.",
        )?;

        self.is_playing = true;
        if let Some(device_id) = query_device_id {
            self.active_device_id = Some(device_id);
            self.sync_active_device_flags();
        }
        self.active_track = Some(SpotifyConnectTrackInfo {
            spotify_uri: spotify_uri.to_string(),
            title: None,
            artists: None,
            album: None,
            cover_art_url: None,
            duration_seconds: None,
        });

        let _ = emit_event(SpotifyConnectEvent {
            event_type: "trackChanged".to_string(),
            receiver_running: Some(self.receiver_running),
            session_connected: Some(self.session_connected),
            is_playing: Some(true),
            current_time_seconds: Some(self.current_time_seconds),
            duration_seconds: Some(self.duration_seconds),
            volume: Some(self.volume),
            active_track: self.active_track.clone(),
            message: Some("Spotify URI playback request sent.".to_string()),
            error: None,
        });

        let _ = emit_event(SpotifyConnectEvent {
            event_type: "play".to_string(),
            receiver_running: Some(self.receiver_running),
            session_connected: Some(self.session_connected),
            is_playing: Some(true),
            current_time_seconds: Some(self.current_time_seconds),
            duration_seconds: Some(self.duration_seconds),
            volume: Some(self.volume),
            active_track: self.active_track.clone(),
            message: Some("Playback started on Spotify Connect target.".to_string()),
            error: None,
        });

        Ok(())
    }

    pub fn start_receiver(&mut self) -> Result<(), SpotifyConnectErrorPayload> {
        self.refresh_receiver_state();
        if self.receiver_running {
            return Ok(());
        }

        let librespot_path = self.resolve_librespot_path()?;
        let mut command = Command::new(&librespot_path);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .arg("--name")
            .arg(self.device_name.clone().unwrap_or_else(|| DEFAULT_DEVICE_NAME.to_string()));

        if let Some(zeroconf_port) = self.zeroconf_port {
            command.arg("--zeroconf-port").arg(zeroconf_port.to_string());
        }

        if let Some(cache_dir) = self.cache_dir.as_ref() {
            command
                .arg("--cache")
                .arg(cache_dir)
                .arg("--system-cache")
                .arg(cache_dir);
        }

        let mut child = command.spawn().map_err(|error| SpotifyConnectErrorPayload {
            code: "receiver-spawn-failed".to_string(),
            message: "Failed to start librespot receiver process.".to_string(),
            details: Some(serde_json::json!({
                "error": error.to_string(),
                "path": librespot_path.to_string_lossy()
            })),
        })?;

        if let Some(stdout) = child.stdout.take() {
            spawn_log_reader(stdout, self.librespot_signals.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_log_reader(stderr, self.librespot_signals.clone());
        }

        self.librespot_child = Some(child);
        self.receiver_running = true;
        self.sync_session_connected_from_signals();
        Ok(())
    }

    pub fn stop_receiver(&mut self) -> Result<(), SpotifyConnectErrorPayload> {
        if let Some(mut child) = self.librespot_child.take() {
            if let Err(error) = child.kill() {
                if error.kind() != std::io::ErrorKind::InvalidInput {
                    return Err(SpotifyConnectErrorPayload {
                        code: "receiver-stop-failed".to_string(),
                        message: "Failed to stop librespot receiver process.".to_string(),
                        details: Some(serde_json::json!({
                            "error": error.to_string()
                        })),
                    });
                }
            }
            let _ = child.wait();
        }

        self.receiver_running = false;
        self.session_connected = false;
        if let Ok(mut signals) = self.librespot_signals.lock() {
            signals.session_connected = false;
        }
        Ok(())
    }

    pub fn dispose(&mut self) -> Result<(), SpotifyConnectErrorPayload> {
        self.stop_receiver()?;
        self.initialized = false;
        self.is_playing = false;
        self.current_time_seconds = 0.0;
        self.duration_seconds = 0.0;
        self.active_track = None;
        self.active_device_id = None;
        self.controller_devices.clear();
        self.access_token = None;
        Ok(())
    }

    pub fn status(&mut self) -> SpotifyConnectStatusResult {
        self.refresh_receiver_state();
        self.sync_session_connected_from_signals();
        SpotifyConnectStatusResult {
            ok: true,
            initialized: self.initialized,
            receiver_running: self.receiver_running,
            session_connected: self.session_connected,
            is_playing: self.is_playing,
            current_time_seconds: self.current_time_seconds,
            duration_seconds: self.duration_seconds,
            volume: self.volume,
            active_device_id: self.active_device_id.clone(),
            active_track: self.active_track.clone(),
            error: None,
        }
    }

    fn require_access_token(&self) -> Result<String, SpotifyConnectErrorPayload> {
        match self.access_token.as_ref() {
            Some(token) if !token.trim().is_empty() => Ok(token.clone()),
            _ => Err(SpotifyConnectErrorPayload {
                code: "missing-access-token".to_string(),
                message: "Spotify access token is missing. Provide accessToken in initialize params."
                    .to_string(),
                details: None,
            }),
        }
    }

    fn send_spotify_put(
        &self,
        path: &str,
        query_device_id: Option<&str>,
        body: Value,
        error_code: &str,
        fallback_message: &str,
    ) -> Result<(), SpotifyConnectErrorPayload> {
        let token = self.require_access_token()?;
        let url = format!("{SPOTIFY_API_BASE_URL}{path}");

        let mut request = self.http_client.put(url).bearer_auth(token).json(&body);
        if let Some(device_id) = query_device_id {
            request = request.query(&[("device_id", device_id)]);
        }

        let response = request.send().map_err(|error| SpotifyConnectErrorPayload {
            code: "spotify-api-network-error".to_string(),
            message: fallback_message.to_string(),
            details: Some(serde_json::json!({
                "error": error.to_string(),
                "path": path
            })),
        })?;

        let status = response.status();
        if status.is_success() {
            return Ok(());
        }

        let body = response.text().unwrap_or_default();
        Err(SpotifyConnectErrorPayload {
            code: error_code.to_string(),
            message: fallback_message.to_string(),
            details: Some(serde_json::json!({
                "status": status.as_u16(),
                "body": body,
                "path": path
            })),
        })
    }

    fn sync_active_device_flags(&mut self) {
        let selected = self.active_device_id.clone();
        for device in &mut self.controller_devices {
            device.is_active = Some(selected.as_ref().is_some_and(|id| id == &device.id));
        }
    }

    fn resolve_librespot_path(&self) -> Result<PathBuf, SpotifyConnectErrorPayload> {
        if let Some(path) = self.librespot_path.as_ref() {
            let candidate = PathBuf::from(path);
            if candidate.exists() {
                return Ok(candidate);
            }
            return Err(SpotifyConnectErrorPayload {
                code: "librespot-not-found".to_string(),
                message: "Configured librespot path does not exist.".to_string(),
                details: Some(serde_json::json!({
                    "path": path
                })),
            });
        }

        if let Some(path) = env::var_os("AONSOKU_LIBRESPOT_PATH") {
            let candidate = PathBuf::from(path);
            if candidate.exists() {
                return Ok(candidate);
            }
        }

        let binary_name = if cfg!(target_os = "windows") {
            "librespot.exe"
        } else {
            "librespot"
        };

        if let Ok(current_dir) = env::current_dir() {
            let release_candidate = current_dir
                .join("native")
                .join("third_party")
                .join("librespot-0.8.0")
                .join("target")
                .join("release")
                .join(binary_name);
            if release_candidate.exists() {
                return Ok(release_candidate);
            }

            let debug_candidate = current_dir
                .join("native")
                .join("third_party")
                .join("librespot-0.8.0")
                .join("target")
                .join("debug")
                .join(binary_name);
            if debug_candidate.exists() {
                return Ok(debug_candidate);
            }
        }

        Ok(PathBuf::from(binary_name))
    }

    fn refresh_receiver_state(&mut self) {
        let mut has_exited = false;
        let mut last_exit_code: Option<i32> = None;

        if let Some(child) = self.librespot_child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    has_exited = true;
                    last_exit_code = status.code();
                }
                Ok(None) => {
                    self.receiver_running = true;
                }
                Err(_) => {
                    has_exited = true;
                }
            }
        } else {
            self.receiver_running = false;
        }

        if has_exited {
            self.librespot_child = None;
            self.receiver_running = false;
            self.session_connected = false;
            if let Ok(mut signals) = self.librespot_signals.lock() {
                signals.session_connected = false;
            }

            let _ = emit_event(SpotifyConnectEvent {
                event_type: "receiverStopped".to_string(),
                receiver_running: Some(false),
                session_connected: Some(false),
                is_playing: Some(false),
                current_time_seconds: Some(0.0),
                duration_seconds: Some(0.0),
                volume: Some(self.volume),
                active_track: None,
                message: Some("librespot receiver process exited.".to_string()),
                error: None,
            });

            if let Some(code) = last_exit_code {
                let _ = emit_event(SpotifyConnectEvent {
                    event_type: "error".to_string(),
                    receiver_running: Some(false),
                    session_connected: Some(false),
                    is_playing: Some(false),
                    current_time_seconds: None,
                    duration_seconds: None,
                    volume: Some(self.volume),
                    active_track: None,
                    message: Some("librespot receiver exited unexpectedly.".to_string()),
                    error: Some(SpotifyConnectErrorPayload {
                        code: "receiver-exited".to_string(),
                        message: "librespot receiver exited unexpectedly.".to_string(),
                        details: Some(serde_json::json!({ "exitCode": code })),
                    }),
                });
            }
        }
    }

    fn sync_session_connected_from_signals(&mut self) {
        if let Ok(signals) = self.librespot_signals.lock() {
            self.session_connected = signals.session_connected;
        }
    }
}

fn spawn_log_reader<R: Read + Send + 'static>(reader: R, signals: Arc<Mutex<LibrespotSignals>>) {
    thread::spawn(move || {
        let line_reader = BufReader::new(reader);
        for line in line_reader.lines().map_while(Result::ok) {
            let normalized = line.to_ascii_lowercase();
            if normalized.contains("authenticated as")
                || normalized.contains("session connected")
                || normalized.contains("connection to ap established")
            {
                if let Ok(mut shared) = signals.lock() {
                    shared.session_connected = true;
                }
                let _ = emit_event(SpotifyConnectEvent {
                    event_type: "sessionConnected".to_string(),
                    receiver_running: Some(true),
                    session_connected: Some(true),
                    is_playing: None,
                    current_time_seconds: None,
                    duration_seconds: None,
                    volume: None,
                    active_track: None,
                    message: Some(line.clone()),
                    error: None,
                });
            } else if normalized.contains("connection to server closed")
                || normalized.contains("session invalid")
                || normalized.contains("disconnected")
            {
                if let Ok(mut shared) = signals.lock() {
                    shared.session_connected = false;
                }
                let _ = emit_event(SpotifyConnectEvent {
                    event_type: "sessionDisconnected".to_string(),
                    receiver_running: Some(true),
                    session_connected: Some(false),
                    is_playing: None,
                    current_time_seconds: None,
                    duration_seconds: None,
                    volume: None,
                    active_track: None,
                    message: Some(line.clone()),
                    error: None,
                });
            } else if normalized.contains("error") {
                let _ = emit_event(SpotifyConnectEvent {
                    event_type: "error".to_string(),
                    receiver_running: None,
                    session_connected: None,
                    is_playing: None,
                    current_time_seconds: None,
                    duration_seconds: None,
                    volume: None,
                    active_track: None,
                    message: Some("librespot emitted an error log.".to_string()),
                    error: Some(SpotifyConnectErrorPayload {
                        code: "librespot-log-error".to_string(),
                        message: line,
                        details: None,
                    }),
                });
            }
        }
    });
}
