use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{self, BufRead, BufReader, Cursor, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use url::Url;

const DEFAULT_TRACK_DURATION_SECONDS: f64 = 300.0;
const TICK_INTERVAL_MS: u64 = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAudioErrorPayload {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarRequest {
    kind: String,
    id: String,
    command: String,
    #[serde(default)]
    params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarResponse {
    kind: String,
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<NativeAudioErrorPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAudioEvent {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_time_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<NativeAudioErrorPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarEventEnvelope {
    kind: String,
    event: NativeAudioEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAudioDeviceInfo {
    id: String,
    name: String,
    mode: String,
    is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAudioInitializeResult {
    ok: bool,
    version: String,
    engine: String,
    message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetOutputModeParams {
    mode: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadParams {
    src: String,
    #[serde(default)]
    autoplay: bool,
    #[serde(default, rename = "loop")]
    loop_value: bool,
    #[serde(default)]
    start_at_seconds: Option<f64>,
    #[serde(default)]
    playback_rate: Option<f64>,
    #[serde(default)]
    duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeekParams {
    position_seconds: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetVolumeParams {
    volume: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetLoopParams {
    #[serde(rename = "loop")]
    loop_value: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPlaybackRateParams {
    playback_rate: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputMode {
    WasapiShared,
    WasapiExclusive,
    Asio,
}

impl OutputMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::WasapiShared => "wasapi-shared",
            Self::WasapiExclusive => "wasapi-exclusive",
            Self::Asio => "asio",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "wasapi-shared" => Some(Self::WasapiShared),
            "wasapi-exclusive" => Some(Self::WasapiExclusive),
            "asio" => Some(Self::Asio),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaybackState {
    Idle,
    Ready,
    Playing,
    Paused,
    Ended,
}

#[derive(Debug, Clone)]
struct EngineState {
    initialized: bool,
    output_mode: OutputMode,
    source: Option<String>,
    playback_state: PlaybackState,
    volume: f64,
    loop_enabled: bool,
    playback_rate: f64,
    current_time_seconds: f64,
    duration_seconds: f64,
    last_tick_instant: Option<Instant>,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            initialized: false,
            output_mode: OutputMode::WasapiShared,
            source: None,
            playback_state: PlaybackState::Idle,
            volume: 1.0,
            loop_enabled: false,
            playback_rate: 1.0,
            current_time_seconds: 0.0,
            duration_seconds: 0.0,
            last_tick_instant: None,
        }
    }
}

impl EngineState {
    fn is_playing(&self) -> bool {
        self.playback_state == PlaybackState::Playing
    }

    fn has_source(&self) -> bool {
        self.source.is_some()
    }

    fn reset_playback_session(&mut self) {
        self.source = None;
        self.playback_state = PlaybackState::Idle;
        self.loop_enabled = false;
        self.playback_rate = 1.0;
        self.current_time_seconds = 0.0;
        self.duration_seconds = 0.0;
        self.last_tick_instant = None;
    }

    fn set_current_time(&mut self, next_time: f64) {
        if self.duration_seconds > 0.0 {
            self.current_time_seconds = next_time.clamp(0.0, self.duration_seconds);
        } else {
            self.current_time_seconds = next_time.max(0.0);
        }
    }

    fn advance_clock(&mut self) -> bool {
        if !self.is_playing() {
            return false;
        }

        let now = Instant::now();
        if let Some(last_tick) = self.last_tick_instant {
            let elapsed_seconds = now.saturating_duration_since(last_tick).as_secs_f64();
            if elapsed_seconds > 0.0 {
                self.current_time_seconds += elapsed_seconds * self.playback_rate;
            }
        }
        self.last_tick_instant = Some(now);

        if self.duration_seconds <= 0.0 {
            return false;
        }

        if self.current_time_seconds < self.duration_seconds {
            return false;
        }

        if self.loop_enabled {
            self.current_time_seconds %= self.duration_seconds;
            return false;
        }

        self.current_time_seconds = self.duration_seconds;
        self.playback_state = PlaybackState::Ended;
        self.last_tick_instant = None;
        true
    }

    fn start_playback(&mut self) -> Result<(), (&'static str, &'static str)> {
        if !self.has_source() {
            return Err(("no-source", "No audio source has been loaded."));
        }

        if self.playback_state == PlaybackState::Ended {
            self.current_time_seconds = 0.0;
        }

        self.playback_state = PlaybackState::Playing;
        self.last_tick_instant = Some(Instant::now());
        Ok(())
    }

    fn pause_playback(&mut self) {
        if self.is_playing() {
            self.advance_clock();
        }

        if self.playback_state != PlaybackState::Ended {
            self.playback_state = PlaybackState::Paused;
        }
        self.last_tick_instant = None;
    }
}
#[derive(Clone)]
struct LoadedAudio {
    data: Arc<[u8]>,
}

#[derive(Default)]
struct AudioRuntime {
    output_stream: Option<OutputStream>,
    output_handle: Option<OutputStreamHandle>,
    sink: Option<Sink>,
    loaded_audio: Option<LoadedAudio>,
}

impl AudioRuntime {
    fn initialize_output(&mut self) -> Result<(), String> {
        if self.output_handle.is_some() {
            return Ok(());
        }

        let (stream, handle) = OutputStream::try_default()
            .map_err(|error| format!("Failed to open default output device: {error}"))?;

        self.output_stream = Some(stream);
        self.output_handle = Some(handle);

        Ok(())
    }

    fn stop_sink(&mut self) {
        if let Some(sink) = self.sink.take() {
            sink.stop();
        }
    }

    fn clear_loaded_audio(&mut self) {
        self.stop_sink();
        self.loaded_audio = None;
    }

    fn create_sink(&self) -> Result<Sink, String> {
        let handle = self
            .output_handle
            .as_ref()
            .ok_or_else(|| "Output device is not initialized.".to_string())?;

        Sink::try_new(handle).map_err(|error| format!("Failed to create output sink: {error}"))
    }

    fn decode_duration_seconds(data: Arc<[u8]>) -> Result<f64, String> {
        let decoder = Decoder::new(BufReader::new(Cursor::new(data)))
            .map_err(|error| format!("Failed to decode audio data: {error}"))?;

        let duration_seconds = decoder
            .total_duration()
            .map(|duration| duration.as_secs_f64())
            .unwrap_or(DEFAULT_TRACK_DURATION_SECONDS);

        if !duration_seconds.is_finite() || duration_seconds < 0.0 {
            return Ok(DEFAULT_TRACK_DURATION_SECONDS);
        }

        Ok(duration_seconds)
    }

    fn fetch_audio_data(src: &str) -> Result<Arc<[u8]>, String> {
        if src.starts_with("http://") || src.starts_with("https://") {
            let response = reqwest::blocking::get(src)
                .map_err(|error| format!("Failed to request source URL: {error}"))?;
            let response = response
                .error_for_status()
                .map_err(|error| format!("Source request failed: {error}"))?;
            let bytes = response
                .bytes()
                .map_err(|error| format!("Failed to read source response: {error}"))?;
            return Ok(Arc::<[u8]>::from(bytes.to_vec()));
        }

        if src.starts_with("file://") {
            let url = Url::parse(src).map_err(|error| format!("Invalid file URL: {error}"))?;
            let path = url
                .to_file_path()
                .map_err(|_| format!("Invalid file URL path: {src}"))?;
            let bytes =
                fs::read(path).map_err(|error| format!("Failed to read local file: {error}"))?;
            return Ok(Arc::<[u8]>::from(bytes));
        }

        let bytes =
            fs::read(src).map_err(|error| format!("Failed to read local source: {error}"))?;
        Ok(Arc::<[u8]>::from(bytes))
    }

    fn rebuild_sink_from_state(&mut self, state: &EngineState) -> Result<(), String> {
        let loaded_audio = self
            .loaded_audio
            .clone()
            .ok_or_else(|| "No loaded audio is available.".to_string())?;

        let sink = self.create_sink()?;
        sink.set_volume(state.volume as f32);

        let decoder = Decoder::new(BufReader::new(Cursor::new(loaded_audio.data.clone())))
            .map_err(|error| format!("Failed to decode loaded audio: {error}"))?;

        let source = decoder
            .skip_duration(Duration::from_secs_f64(state.current_time_seconds.max(0.0)))
            .speed(state.playback_rate.max(0.01) as f32);

        if state.loop_enabled {
            sink.append(source.repeat_infinite());
        } else {
            sink.append(source);
        }

        self.stop_sink();
        self.sink = Some(sink);

        Ok(())
    }

    fn play_sink(&self) {
        if let Some(sink) = &self.sink {
            sink.play();
        }
    }

    fn pause_sink(&self) {
        if let Some(sink) = &self.sink {
            sink.pause();
        }
    }

    fn is_sink_empty(&self) -> bool {
        self.sink.as_ref().map(|sink| sink.empty()).unwrap_or(false)
    }
}

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

fn write_json_line<T: Serialize>(value: &T) -> io::Result<()> {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    serde_json::to_writer(&mut handle, value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    handle.write_all(b"\n")?;
    handle.flush()?;
    Ok(())
}

fn emit_event(
    event_type: &str,
    current_time: Option<f64>,
    duration: Option<f64>,
    error: Option<NativeAudioErrorPayload>,
) -> io::Result<()> {
    let envelope = SidecarEventEnvelope {
        kind: "event".to_string(),
        event: NativeAudioEvent {
            event_type: event_type.to_string(),
            current_time_seconds: current_time,
            duration_seconds: duration,
            error,
        },
    };
    write_json_line(&envelope)
}

fn emit_simple_event(
    event_type: &str,
    current_time: Option<f64>,
    duration: Option<f64>,
) -> io::Result<()> {
    emit_event(event_type, current_time, duration, None)
}

fn emit_error_event(code: &str, message: &str, details: Option<Value>) -> io::Result<()> {
    emit_event(
        "error",
        None,
        None,
        Some(NativeAudioErrorPayload {
            code: code.to_string(),
            message: message.to_string(),
            details,
        }),
    )
}

fn emit_response_ok(id: &str, result: Option<Value>) -> io::Result<()> {
    write_json_line(&SidecarResponse {
        kind: "response".to_string(),
        id: id.to_string(),
        ok: true,
        result,
        error: None,
    })
}

fn emit_response_error(
    id: &str,
    code: &str,
    message: &str,
    details: Option<Value>,
) -> io::Result<()> {
    write_json_line(&SidecarResponse {
        kind: "response".to_string(),
        id: id.to_string(),
        ok: false,
        result: None,
        error: Some(NativeAudioErrorPayload {
            code: code.to_string(),
            message: message.to_string(),
            details,
        }),
    })
}

fn emit_command_error(
    id: &str,
    code: &str,
    message: &str,
    details: Option<Value>,
) -> io::Result<()> {
    emit_error_event(code, message, details.clone())?;
    emit_response_error(id, code, message, details)
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, String> {
    let payload = params.ok_or_else(|| "Missing params".to_string())?;
    serde_json::from_value(payload).map_err(|error| error.to_string())
}

fn command_result_ok_value() -> Value {
    serde_json::json!({ "ok": true })
}

fn ensure_shared_output_mode(state: &EngineState, request_id: &str) -> io::Result<bool> {
    if state.output_mode == OutputMode::WasapiShared {
        return Ok(true);
    }

    emit_command_error(
        request_id,
        "unsupported-output-mode",
        "Current build supports only wasapi-shared output mode.",
        Some(serde_json::json!({ "mode": state.output_mode.as_str() })),
    )?;

    Ok(false)
}

fn run_tick(state: &mut EngineState, runtime: &AudioRuntime) -> io::Result<()> {
    if !state.is_playing() {
        return Ok(());
    }

    let ended_by_clock = state.advance_clock();
    let ended_by_sink = !state.loop_enabled && runtime.is_sink_empty();

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

                match request.command.as_str() {
                    "initialize" => {
                        if let Err(message) = runtime.initialize_output() {
                            emit_command_error(&request.id, "output-init-failed", &message, None)?;
                            continue;
                        }

                        let already_initialized = state.initialized;
                        state.initialized = true;

                        emit_simple_event("ready", None, None)?;

                        let init_result = NativeAudioInitializeResult {
                            ok: true,
                            version: env!("CARGO_PKG_VERSION").to_string(),
                            engine: "rust-sidecar".to_string(),
                            message: if already_initialized {
                                "Rust sidecar already initialized.".to_string()
                            } else {
                                "Rust sidecar initialized.".to_string()
                            },
                        };

                        emit_response_ok(
                            &request.id,
                            Some(
                                serde_json::to_value(init_result)
                                    .unwrap_or_else(|_| serde_json::json!({ "ok": true })),
                            ),
                        )?;
                    }
                    "listDevices" => {
                        let devices = vec![
                            NativeAudioDeviceInfo {
                                id: "default-shared".to_string(),
                                name: "Default Device (Shared)".to_string(),
                                mode: OutputMode::WasapiShared.as_str().to_string(),
                                is_default: true,
                            },
                        ];

                        emit_response_ok(
                            &request.id,
                            Some(
                                serde_json::to_value(devices)
                                    .unwrap_or_else(|_| serde_json::json!([])),
                            ),
                        )?;
                    }
                    "setOutputMode" => match parse_params::<SetOutputModeParams>(request.params) {
                        Ok(params) => {
                            let mode = match OutputMode::parse(&params.mode) {
                                Some(value) => value,
                                None => {
                                    emit_command_error(
                                        &request.id,
                                        "unsupported-output-mode",
                                        "Output mode must be one of wasapi-shared / wasapi-exclusive / asio.",
                                        Some(serde_json::json!({ "mode": params.mode })),
                                    )?;
                                    continue;
                                }
                            };

                            if mode != OutputMode::WasapiShared {
                                emit_command_error(
                                    &request.id,
                                    "unsupported-output-mode",
                                    "Current build supports only wasapi-shared output mode.",
                                    Some(
                                        serde_json::json!({
                                            "mode": mode.as_str(),
                                            "supportedModes": ["wasapi-shared"]
                                        }),
                                    ),
                                )?;
                                continue;
                            }

                            state.output_mode = mode;

                            emit_simple_event("deviceChanged", None, None)?;
                            emit_response_ok(&request.id, Some(command_result_ok_value()))?;
                        }
                        Err(message) => {
                            emit_command_error(&request.id, "invalid-params", &message, None)?;
                        }
                    },
                    "load" => {
                        if !state.initialized {
                            emit_command_error(
                                &request.id,
                                "not-initialized",
                                "Call initialize before load.",
                                None,
                            )?;
                            continue;
                        }

                        if !ensure_shared_output_mode(&state, &request.id)? {
                            continue;
                        }

                        match parse_params::<LoadParams>(request.params) {
                            Ok(params) => {
                                if params.src.trim().is_empty() {
                                    emit_command_error(
                                        &request.id,
                                        "invalid-source",
                                        "Audio source is required.",
                                        None,
                                    )?;
                                    continue;
                                }

                                if let Some(start_at_seconds) = params.start_at_seconds {
                                    if !start_at_seconds.is_finite() || start_at_seconds < 0.0 {
                                        emit_command_error(
                                            &request.id,
                                            "invalid-start-position",
                                            "startAtSeconds must be a finite number >= 0.",
                                            None,
                                        )?;
                                        continue;
                                    }
                                }

                                if let Some(playback_rate) = params.playback_rate {
                                    if !playback_rate.is_finite() || playback_rate <= 0.0 {
                                        emit_command_error(
                                            &request.id,
                                            "invalid-playback-rate",
                                            "Playback rate must be a finite number > 0.",
                                            None,
                                        )?;
                                        continue;
                                    }
                                }

                                if let Some(duration_seconds) = params.duration_seconds {
                                    if !duration_seconds.is_finite() || duration_seconds < 0.0 {
                                        emit_command_error(
                                            &request.id,
                                            "invalid-duration",
                                            "durationSeconds must be a finite number >= 0.",
                                            None,
                                        )?;
                                        continue;
                                    }
                                }

                                let audio_data = match AudioRuntime::fetch_audio_data(&params.src) {
                                    Ok(data) => data,
                                    Err(message) => {
                                        emit_command_error(
                                            &request.id,
                                            "source-fetch-failed",
                                            &message,
                                            None,
                                        )?;
                                        continue;
                                    }
                                };

                                let duration_seconds = if let Some(duration) =
                                    params.duration_seconds
                                {
                                    duration
                                } else {
                                    match AudioRuntime::decode_duration_seconds(audio_data.clone())
                                    {
                                        Ok(duration) => duration,
                                        Err(message) => {
                                            emit_command_error(
                                                &request.id,
                                                "source-decode-failed",
                                                &message,
                                                None,
                                            )?;
                                            continue;
                                        }
                                    }
                                };

                                if let Err(message) = runtime.initialize_output() {
                                    emit_command_error(
                                        &request.id,
                                        "output-init-failed",
                                        &message,
                                        None,
                                    )?;
                                    continue;
                                }

                                state.source = Some(params.src);
                                state.playback_state = PlaybackState::Ready;
                                state.loop_enabled = params.loop_value;
                                state.playback_rate = params.playback_rate.unwrap_or(1.0);
                                state.duration_seconds = duration_seconds;
                                state.set_current_time(params.start_at_seconds.unwrap_or(0.0));
                                state.last_tick_instant = None;

                                runtime.loaded_audio = Some(LoadedAudio { data: audio_data });

                                if let Err(message) = runtime.rebuild_sink_from_state(&state) {
                                    emit_command_error(
                                        &request.id,
                                        "playback-pipeline-failed",
                                        &message,
                                        None,
                                    )?;
                                    continue;
                                }

                                emit_simple_event(
                                    "loadedmetadata",
                                    Some(state.current_time_seconds),
                                    Some(state.duration_seconds),
                                )?;

                                if params.autoplay {
                                    if let Err((code, message)) = state.start_playback() {
                                        emit_command_error(&request.id, code, message, None)?;
                                        continue;
                                    }
                                    runtime.play_sink();
                                    emit_simple_event("play", None, None)?;
                                } else {
                                    state.playback_state = PlaybackState::Ready;
                                    state.last_tick_instant = None;
                                    runtime.pause_sink();
                                }

                                emit_response_ok(&request.id, Some(command_result_ok_value()))?;
                            }
                            Err(message) => {
                                emit_command_error(&request.id, "invalid-params", &message, None)?;
                            }
                        }
                    }
                    "play" => {
                        if !state.initialized {
                            emit_command_error(
                                &request.id,
                                "not-initialized",
                                "Call initialize before play.",
                                None,
                            )?;
                            continue;
                        }

                        if !ensure_shared_output_mode(&state, &request.id)? {
                            continue;
                        }

                        match state.start_playback() {
                            Ok(()) => {
                                if let Err(message) = runtime.rebuild_sink_from_state(&state) {
                                    emit_command_error(
                                        &request.id,
                                        "playback-pipeline-failed",
                                        &message,
                                        None,
                                    )?;
                                    continue;
                                }
                                runtime.play_sink();
                                emit_simple_event("play", None, None)?;
                                emit_response_ok(&request.id, Some(command_result_ok_value()))?;
                            }
                            Err((code, message)) => {
                                emit_command_error(&request.id, code, message, None)?;
                            }
                        }
                    }
                    "pause" => {
                        if !state.initialized {
                            emit_command_error(
                                &request.id,
                                "not-initialized",
                                "Call initialize before pause.",
                                None,
                            )?;
                            continue;
                        }

                        if !ensure_shared_output_mode(&state, &request.id)? {
                            continue;
                        }

                        if !state.has_source() {
                            emit_command_error(
                                &request.id,
                                "no-source",
                                "No audio source has been loaded.",
                                None,
                            )?;
                            continue;
                        }

                        state.pause_playback();
                        runtime.pause_sink();
                        emit_simple_event("pause", None, None)?;
                        emit_response_ok(&request.id, Some(command_result_ok_value()))?;
                    }
                    "seek" => {
                        if !state.initialized {
                            emit_command_error(
                                &request.id,
                                "not-initialized",
                                "Call initialize before seek.",
                                None,
                            )?;
                            continue;
                        }

                        if !ensure_shared_output_mode(&state, &request.id)? {
                            continue;
                        }

                        if !state.has_source() {
                            emit_command_error(
                                &request.id,
                                "no-source",
                                "No audio source has been loaded.",
                                None,
                            )?;
                            continue;
                        }

                        match parse_params::<SeekParams>(request.params) {
                            Ok(params) => {
                                if !params.position_seconds.is_finite()
                                    || params.position_seconds < 0.0
                                {
                                    emit_command_error(
                                        &request.id,
                                        "invalid-seek-position",
                                        "Seek position must be a finite number >= 0.",
                                        None,
                                    )?;
                                    continue;
                                }

                                if state.is_playing() {
                                    state.advance_clock();
                                }

                                state.set_current_time(params.position_seconds);
                                if state.playback_state == PlaybackState::Ended {
                                    state.playback_state = PlaybackState::Paused;
                                }

                                if let Err(message) = runtime.rebuild_sink_from_state(&state) {
                                    emit_command_error(
                                        &request.id,
                                        "playback-pipeline-failed",
                                        &message,
                                        None,
                                    )?;
                                    continue;
                                }

                                if state.is_playing() {
                                    runtime.play_sink();
                                    state.last_tick_instant = Some(Instant::now());
                                } else {
                                    runtime.pause_sink();
                                }

                                emit_simple_event(
                                    "timeupdate",
                                    Some(state.current_time_seconds),
                                    Some(state.duration_seconds),
                                )?;
                                emit_response_ok(&request.id, Some(command_result_ok_value()))?;
                            }
                            Err(message) => {
                                emit_command_error(&request.id, "invalid-params", &message, None)?;
                            }
                        }
                    }
                    "setVolume" => match parse_params::<SetVolumeParams>(request.params) {
                        Ok(params) => {
                            if !params.volume.is_finite() || !(0.0..=1.0).contains(&params.volume) {
                                emit_command_error(
                                    &request.id,
                                    "invalid-volume",
                                    "Volume must be a finite number in range [0, 1].",
                                    None,
                                )?;
                                continue;
                            }

                            state.volume = params.volume;
                            if let Some(sink) = &runtime.sink {
                                sink.set_volume(params.volume as f32);
                            }

                            emit_response_ok(&request.id, Some(command_result_ok_value()))?;
                        }
                        Err(message) => {
                            emit_command_error(&request.id, "invalid-params", &message, None)?;
                        }
                    },
                    "setLoop" => match parse_params::<SetLoopParams>(request.params) {
                        Ok(params) => {
                            state.loop_enabled = params.loop_value;

                            if state.has_source() {
                                if let Err(message) = runtime.rebuild_sink_from_state(&state) {
                                    emit_command_error(
                                        &request.id,
                                        "playback-pipeline-failed",
                                        &message,
                                        None,
                                    )?;
                                    continue;
                                }

                                if state.is_playing() {
                                    runtime.play_sink();
                                    state.last_tick_instant = Some(Instant::now());
                                } else {
                                    runtime.pause_sink();
                                }
                            }

                            emit_response_ok(&request.id, Some(command_result_ok_value()))?;
                        }
                        Err(message) => {
                            emit_command_error(&request.id, "invalid-params", &message, None)?;
                        }
                    },
                    "setPlaybackRate" => {
                        match parse_params::<SetPlaybackRateParams>(request.params) {
                            Ok(params) => {
                                if !params.playback_rate.is_finite() || params.playback_rate <= 0.0
                                {
                                    emit_command_error(
                                        &request.id,
                                        "invalid-playback-rate",
                                        "Playback rate must be a finite number > 0.",
                                        None,
                                    )?;
                                    continue;
                                }

                                if state.is_playing() {
                                    state.advance_clock();
                                }

                                state.playback_rate = params.playback_rate;

                                if state.has_source() {
                                    if let Err(message) = runtime.rebuild_sink_from_state(&state) {
                                        emit_command_error(
                                            &request.id,
                                            "playback-pipeline-failed",
                                            &message,
                                            None,
                                        )?;
                                        continue;
                                    }

                                    if state.is_playing() {
                                        runtime.play_sink();
                                        state.last_tick_instant = Some(Instant::now());
                                    } else {
                                        runtime.pause_sink();
                                    }
                                }

                                emit_response_ok(&request.id, Some(command_result_ok_value()))?;
                            }
                            Err(message) => {
                                emit_command_error(&request.id, "invalid-params", &message, None)?;
                            }
                        }
                    }
                    "dispose" => {
                        runtime.clear_loaded_audio();
                        state.reset_playback_session();
                        emit_response_ok(&request.id, Some(command_result_ok_value()))?;
                    }
                    _ => {
                        emit_command_error(
                            &request.id,
                            "unknown-command",
                            "Unknown command was requested.",
                            Some(serde_json::json!({ "command": request.command })),
                        )?;
                    }
                }
            }
            Ok(InputMessage::Eof) => break,
            Err(RecvTimeoutError::Timeout) => {
                run_tick(&mut state, &runtime)?;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    Ok(())
}
