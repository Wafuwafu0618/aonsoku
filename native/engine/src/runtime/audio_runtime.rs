use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;

use rodio::{OutputStream, OutputStreamHandle, Sink};
use url::Url;

use crate::audio::{
    probe_default_exclusive_open, run_default_exclusive_playback, SharedCpalOutput,
    SharedPcmTrack,
};
use crate::decoder::{
    default_decoder_backend, DecodePlaybackOptions, DecodedPcmData, DecodedSourceInfo,
    DecoderBackend,
};
use crate::engine::{EngineState, OutputMode};
use crate::error::RuntimeError;

const EXCLUSIVE_LOCK_FILE_NAME: &str = "aonsoku-native-audio-exclusive.lock";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SharedOutputBackend {
    Rodio,
    Cpal,
}

impl SharedOutputBackend {
    fn as_str(self) -> &'static str {
        match self {
            Self::Rodio => "rodio",
            Self::Cpal => "cpal",
        }
    }
}

fn default_shared_output_backend() -> SharedOutputBackend {
    let backend_name = std::env::var("AONSOKU_NATIVE_SHARED_OUTPUT")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "cpal".to_string());

    match backend_name.as_str() {
        "rodio" => SharedOutputBackend::Rodio,
        "cpal" => SharedOutputBackend::Cpal,
        unsupported => {
            eprintln!(
                "[NativeAudioSidecar][M3] unsupported shared output backend '{}', fallback to cpal",
                unsupported
            );
            SharedOutputBackend::Cpal
        }
    }
}

#[derive(Clone)]
pub struct LoadedAudio {
    pub data: Arc<[u8]>,
}

#[derive(Clone)]
pub struct ExclusivePlaybackParams {
    pub track: SharedPcmTrack,
    pub start_at_seconds: f64,
    pub playback_rate: f64,
    pub loop_enabled: bool,
    pub volume: f32,
    pub target_sample_rate_hz: Option<u32>,
    pub oversampling_filter_id: Option<String>,
}

pub struct ExclusivePlaybackSession {
    pub stop_sender: mpsc::Sender<()>,
    pub finished: Arc<AtomicBool>,
    pub ended_naturally: Arc<AtomicBool>,
    pub join_handle: Option<thread::JoinHandle<()>>,
}

impl ExclusivePlaybackSession {
    pub fn request_stop(&self) {
        let _ = self.stop_sender.send(());
    }

    pub fn is_finished(&self) -> bool {
        self.finished.load(Ordering::Relaxed)
    }

    pub fn ended_naturally(&self) -> bool {
        self.ended_naturally.load(Ordering::Relaxed)
    }
}

pub struct AudioRuntime {
    pub decoder_backend: Arc<dyn DecoderBackend>,
    pub shared_output_backend: SharedOutputBackend,
    pub output_stream: Option<OutputStream>,
    pub output_handle: Option<OutputStreamHandle>,
    pub sink: Option<Sink>,
    pub shared_cpal_output: Option<SharedCpalOutput>,
    pub loaded_audio: Option<LoadedAudio>,
    pub shared_decoded_pcm: Option<DecodedPcmData>,
    pub exclusive_decoded_pcm: Option<DecodedPcmData>,
    pub exclusive_prepared_playback: Option<ExclusivePlaybackParams>,
    pub exclusive_playback: Option<ExclusivePlaybackSession>,
    pub exclusive_playback_ended: bool,
    pub exclusive_lock: Option<File>,
    pub exclusive_lock_path: PathBuf,
    pub active_output_mode: OutputMode,
    pub exclusive_probe_verified: bool,
}

impl Default for AudioRuntime {
    fn default() -> Self {
        let decoder_backend = default_decoder_backend();
        let shared_output_backend = default_shared_output_backend();
        eprintln!(
            "[NativeAudioSidecar][M2] decoder backend selected={}",
            decoder_backend.name()
        );
        eprintln!(
            "[NativeAudioSidecar][M3] shared output backend selected={}",
            shared_output_backend.as_str()
        );

        Self {
            decoder_backend,
            shared_output_backend,
            output_stream: None,
            output_handle: None,
            sink: None,
            shared_cpal_output: None,
            loaded_audio: None,
            shared_decoded_pcm: None,
            exclusive_decoded_pcm: None,
            exclusive_prepared_playback: None,
            exclusive_playback: None,
            exclusive_playback_ended: false,
            exclusive_lock: None,
            exclusive_lock_path: std::env::temp_dir().join(EXCLUSIVE_LOCK_FILE_NAME),
            active_output_mode: OutputMode::WasapiShared,
            exclusive_probe_verified: false,
        }
    }
}

impl AudioRuntime {
    pub fn decoder_backend_name(&self) -> &'static str {
        self.decoder_backend.name()
    }

    pub fn inspect_source_info(&self, data: Arc<[u8]>) -> Result<DecodedSourceInfo, String> {
        self.decoder_backend.inspect(data)
    }

    pub fn emit_decode_audit(
        &self,
        output_mode: OutputMode,
        target_sample_rate_hz: Option<u32>,
        oversampling_filter_id: Option<&str>,
        source_info: &DecodedSourceInfo,
        conversion_path: &str,
        underrun_count: Option<u64>,
    ) {
        let target_sample_rate_label = target_sample_rate_hz
            .map(|value| value.to_string())
            .unwrap_or_else(|| "auto".to_string());
        let filter_label = oversampling_filter_id.unwrap_or("none");
        let underrun_label = underrun_count
            .map(|count| count.to_string())
            .unwrap_or_else(|| "n/a".to_string());

        eprintln!(
            "[NativeAudioSidecar][M0] decode-audit decoder={} source={}ch@{}Hz duration={:.3}s outputMode={} targetSampleRateHz={} oversamplingFilter={} conversionPath={} underrunCount={} policy=bit-perfect-until-dsp",
            self.decoder_backend_name(),
            source_info.channels,
            source_info.sample_rate_hz,
            source_info.duration_seconds,
            output_mode.as_str(),
            target_sample_rate_label,
            filter_label,
            conversion_path,
            underrun_label,
        );
    }

    fn try_create_exclusive_lock_file(&self) -> io::Result<File> {
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&self.exclusive_lock_path)
    }

    fn read_exclusive_lock_pid(&self) -> Option<u32> {
        let contents = fs::read_to_string(&self.exclusive_lock_path).ok()?;
        contents.lines().next()?.trim().parse::<u32>().ok()
    }

    #[cfg(target_os = "windows")]
    fn is_process_alive(pid: u32) -> bool {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let process_handle =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) };

        match process_handle {
            Ok(handle) => {
                unsafe {
                    let _ = CloseHandle(handle);
                }
                true
            }
            Err(_) => false,
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn is_process_alive(_pid: u32) -> bool {
        false
    }

    fn clear_stale_exclusive_lock_file(&self) -> bool {
        if !self.exclusive_lock_path.exists() {
            return false;
        }

        let should_remove = match self.read_exclusive_lock_pid() {
            Some(pid) => pid == std::process::id() || !Self::is_process_alive(pid),
            None => true,
        };

        if !should_remove {
            return false;
        }

        fs::remove_file(&self.exclusive_lock_path).is_ok()
    }

    pub fn can_offer_exclusive_mode(&self) -> bool {
        if !cfg!(target_os = "windows") {
            return false;
        }

        if self.exclusive_lock.is_some() {
            return true;
        }

        // If we already opened output in this process, probing again can fail because
        // our own shared stream occupies the endpoint. In that case, trust lock state.
        if self.output_handle.is_some() || self.shared_cpal_output.is_some() {
            return true;
        }

        match probe_default_exclusive_open() {
            Ok(()) => true,
            Err(error) => {
                // Capability is about support, not current availability.
                // Keep exclusive selectable for transient cases (busy/device state),
                // and fail only when support is fundamentally unavailable.
                if error.code == "exclusive-open-unsupported"
                    || error.code == "exclusive-format-unsupported"
                {
                    eprintln!(
                        "[NativeAudioSidecar] exclusive capability unavailable: {} ({})",
                        error.message, error.code
                    );
                    return false;
                }

                true
            }
        }
    }

    pub fn ensure_mode_resources(&mut self, mode: OutputMode) -> Result<(), RuntimeError> {
        match mode {
            OutputMode::WasapiShared => {
                self.release_exclusive_lock();
                Ok(())
            }
            OutputMode::WasapiExclusive => {
                self.acquire_exclusive_lock()?;

                if self.active_output_mode == OutputMode::WasapiExclusive
                    && self.exclusive_probe_verified
                {
                    return Ok(());
                }

                if let Err(error) = probe_default_exclusive_open() {
                    self.release_exclusive_lock();
                    return Err(RuntimeError::new(error.code, error.message));
                }

                self.exclusive_probe_verified = true;
                Ok(())
            }
            OutputMode::Asio => Err(RuntimeError::new(
                "unsupported-output-mode",
                "Current build does not support ASIO output mode yet. Use wasapi-shared or wasapi-exclusive.",
            )),
        }
    }

    pub fn configure_output_mode(&mut self, mode: OutputMode) -> Result<(), RuntimeError> {
        let switching_shared_to_exclusive =
            self.active_output_mode == OutputMode::WasapiShared
                && mode == OutputMode::WasapiExclusive;

        // Important: release shared output before exclusive probe.
        // Otherwise this process can occupy the same endpoint and cause
        // false exclusive-open failures during setOutputMode.
        if switching_shared_to_exclusive {
            self.reset_output_device();
            if let Err(error) = self.ensure_mode_resources(mode) {
                if let Err(restore_error) = self.initialize_shared_output_with_retry() {
                    eprintln!(
                        "[NativeAudioSidecar] failed to restore shared output after exclusive probe failure: {restore_error}"
                    );
                }
                self.active_output_mode = OutputMode::WasapiShared;
                return Err(error);
            }
        } else {
            self.ensure_mode_resources(mode)?;
            self.reset_output_device();
        }

        if mode == OutputMode::WasapiShared {
            if let Err(message) = self.initialize_shared_output_with_retry() {
                return Err(RuntimeError::new("output-init-failed", message));
            }
        }

        self.active_output_mode = mode;
        Ok(())
    }

    pub fn reset_output_device(&mut self) {
        self.stop_sink();
        self.output_handle = None;
        self.output_stream = None;
        self.shared_cpal_output = None;
        self.exclusive_prepared_playback = None;
        self.exclusive_playback = None;
        self.exclusive_playback_ended = false;
    }

    fn acquire_exclusive_lock(&mut self) -> Result<(), RuntimeError> {
        if self.exclusive_lock.is_some() {
            return Ok(());
        }

        let mut lock_result = self.try_create_exclusive_lock_file();
        if let Err(error) = &lock_result {
            if error.kind() == io::ErrorKind::AlreadyExists
                && self.clear_stale_exclusive_lock_file()
            {
                lock_result = self.try_create_exclusive_lock_file();
            }
        }

        let lock_file = lock_result.map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                RuntimeError::new(
                    "exclusive-device-busy",
                    format!(
                        "Exclusive output mode is already in use (lock: {}).",
                        self.exclusive_lock_path.display()
                    ),
                )
            } else {
                RuntimeError::new(
                    "exclusive-lock-failed",
                    format!(
                        "Failed to create exclusive output lock file ({}): {error}",
                        self.exclusive_lock_path.display()
                    ),
                )
            }
        })?;

        let mut lock_file = lock_file;
        let pid = std::process::id();
        let _ = writeln!(lock_file, "{pid}");

        self.exclusive_lock = Some(lock_file);
        Ok(())
    }

    pub fn release_exclusive_lock(&mut self) {
        self.exclusive_lock = None;
        self.exclusive_probe_verified = false;

        if self.exclusive_lock_path.exists() {
            let _ = fs::remove_file(&self.exclusive_lock_path);
        }
    }

    fn initialize_output(&mut self) -> Result<(), String> {
        if self.active_output_mode == OutputMode::WasapiExclusive {
            return Ok(());
        }

        match self.shared_output_backend {
            SharedOutputBackend::Rodio => {
                if self.output_handle.is_some() {
                    return Ok(());
                }

                let (stream, handle) = OutputStream::try_default()
                    .map_err(|error| format!("Failed to open default output device: {error}"))?;

                self.output_stream = Some(stream);
                self.output_handle = Some(handle);
            }
            SharedOutputBackend::Cpal => {
                if self.shared_cpal_output.is_some() {
                    return Ok(());
                }

                let output = SharedCpalOutput::new_default()?;
                eprintln!(
                    "[NativeAudioSidecar][M3] shared cpal output initialized config={}",
                    output.output_config_label()
                );
                self.shared_cpal_output = Some(output);
                self.output_stream = None;
                self.output_handle = None;
            }
        }

        Ok(())
    }

    pub fn initialize_shared_output_with_retry(&mut self) -> Result<(), String> {
        self.active_output_mode = OutputMode::WasapiShared;

        if let Err(first_error) = self.initialize_output() {
            self.shared_cpal_output = None;
            self.output_handle = None;
            self.output_stream = None;

            return self.initialize_output().map_err(|second_error| {
                format!("{first_error} (retry failed: {second_error})")
            });
        }

        Ok(())
    }

    pub fn stop_sink(&mut self) {
        self.stop_exclusive_playback();

        if let Some(shared_output) = &self.shared_cpal_output {
            shared_output.set_playing(false);
        }

        if let Some(sink) = self.sink.take() {
            sink.stop();
        }
    }

    pub fn clear_loaded_audio(&mut self) {
        self.stop_sink();
        self.loaded_audio = None;
        self.shared_decoded_pcm = None;
        self.exclusive_decoded_pcm = None;
        if let Some(shared_output) = &self.shared_cpal_output {
            shared_output.clear_track();
        }
        self.exclusive_prepared_playback = None;
        self.exclusive_playback_ended = false;
    }

    pub fn shutdown(&mut self) {
        self.clear_loaded_audio();
        self.reset_output_device();
        self.release_exclusive_lock();
        self.active_output_mode = OutputMode::WasapiShared;
    }

    fn cleanup_finished_exclusive_playback(&mut self) {
        let should_cleanup = self
            .exclusive_playback
            .as_ref()
            .map(|session| session.is_finished())
            .unwrap_or(false);

        if !should_cleanup {
            return;
        }

        if let Some(mut session) = self.exclusive_playback.take() {
            self.exclusive_playback_ended = session.ended_naturally();
            if let Some(handle) = session.join_handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn stop_exclusive_playback(&mut self) {
        if let Some(mut session) = self.exclusive_playback.take() {
            session.request_stop();
            if let Some(handle) = session.join_handle.take() {
                let _ = handle.join();
            }
        }
        self.exclusive_playback_ended = false;
    }

    fn prepare_exclusive_playback(&mut self, state: &EngineState) -> Result<(), String> {
        let (source_info, conversion_path, samples) = {
            let decoded = self.get_or_decode_exclusive_pcm()?;
            (
                decoded.source_info.clone(),
                decoded.conversion_path,
                Arc::clone(&decoded.samples),
            )
        };

        let track = SharedPcmTrack {
            samples,
            channels: source_info.channels,
            sample_rate_hz: source_info.sample_rate_hz,
        };
        let conversion_path =
            format!("{conversion_path}->exclusive-wasapi-worker");

        self.emit_decode_audit(
            OutputMode::WasapiExclusive,
            state.target_sample_rate_hz,
            state.oversampling_filter_id.as_deref(),
            &source_info,
            &conversion_path,
            None,
        );

        self.stop_exclusive_playback();
        self.exclusive_prepared_playback = Some(ExclusivePlaybackParams {
            track,
            start_at_seconds: state.current_time_seconds.max(0.0),
            playback_rate: state.playback_rate.max(0.01),
            loop_enabled: state.loop_enabled,
            volume: state.volume as f32,
            target_sample_rate_hz: state.target_sample_rate_hz,
            oversampling_filter_id: state.oversampling_filter_id.clone(),
        });
        self.exclusive_playback_ended = false;

        Ok(())
    }

    fn start_exclusive_playback(&mut self) -> Result<(), String> {
        self.cleanup_finished_exclusive_playback();

        if self
            .exclusive_playback
            .as_ref()
            .map(|session| !session.is_finished())
            .unwrap_or(false)
        {
            return Ok(());
        }

        let params = self
            .exclusive_prepared_playback
            .clone()
            .ok_or_else(|| "No prepared exclusive playback is available.".to_string())?;

        let (stop_sender, stop_receiver) = mpsc::channel::<()>();
        let finished = Arc::new(AtomicBool::new(false));
        let ended_naturally = Arc::new(AtomicBool::new(false));
        self.exclusive_playback_ended = false;

        let finished_for_worker = Arc::clone(&finished);
        let ended_naturally_for_worker = Arc::clone(&ended_naturally);

        let join_handle = thread::spawn(move || {
            let playback_result = run_default_exclusive_playback(
                params.track,
                params.start_at_seconds,
                params.playback_rate,
                params.loop_enabled,
                params.volume,
                params.target_sample_rate_hz,
                params.oversampling_filter_id,
                stop_receiver,
            );

            match playback_result {
                Ok(ended) => {
                    ended_naturally_for_worker.store(ended, Ordering::Relaxed);
                }
                Err(error) => {
                    eprintln!(
                        "[NativeAudioSidecar] exclusive playback worker failed: {} ({})",
                        error.message, error.code
                    );
                    ended_naturally_for_worker.store(true, Ordering::Relaxed);
                }
            }

            finished_for_worker.store(true, Ordering::Relaxed);
        });

        self.exclusive_playback = Some(ExclusivePlaybackSession {
            stop_sender,
            finished,
            ended_naturally,
            join_handle: Some(join_handle),
        });

        Ok(())
    }

    fn create_sink(&self) -> Result<Sink, String> {
        let handle = self
            .output_handle
            .as_ref()
            .ok_or_else(|| "Output device is not initialized.".to_string())?;

        Sink::try_new(handle).map_err(|error| format!("Failed to create output sink: {error}"))
    }

    fn shared_underrun_count(&self) -> Option<u64> {
        self.shared_cpal_output
            .as_ref()
            .map(|output| output.underrun_count())
    }

    pub fn set_shared_volume(&mut self, volume: f32) {
        if self.active_output_mode == OutputMode::WasapiExclusive {
            return;
        }

        if let Some(shared_output) = &self.shared_cpal_output {
            shared_output.set_volume(volume);
        }
    }

    fn get_or_decode_shared_pcm(&mut self) -> Result<&DecodedPcmData, String> {
        if self.shared_decoded_pcm.is_none() {
            if let Some(exclusive_decoded) = self.exclusive_decoded_pcm.clone() {
                self.shared_decoded_pcm = Some(exclusive_decoded);
            } else {
                let loaded_audio = self
                    .loaded_audio
                    .clone()
                    .ok_or_else(|| "No loaded audio is available.".to_string())?;
                let decoded = self.decoder_backend.decode_pcm(loaded_audio.data)?;
                self.shared_decoded_pcm = Some(decoded);
            }
        }

        self.shared_decoded_pcm
            .as_ref()
            .ok_or_else(|| "Shared PCM decode cache is unavailable.".to_string())
    }

    fn get_or_decode_exclusive_pcm(&mut self) -> Result<&DecodedPcmData, String> {
        if self.exclusive_decoded_pcm.is_none() {
            if let Some(shared_decoded) = self.shared_decoded_pcm.clone() {
                self.exclusive_decoded_pcm = Some(shared_decoded);
            } else {
                let loaded_audio = self
                    .loaded_audio
                    .clone()
                    .ok_or_else(|| "No loaded audio is available.".to_string())?;
                let decoded = self.decoder_backend.decode_pcm(loaded_audio.data)?;
                self.exclusive_decoded_pcm = Some(decoded);
            }
        }

        self.exclusive_decoded_pcm
            .as_ref()
            .ok_or_else(|| "Exclusive PCM decode cache is unavailable.".to_string())
    }

    pub fn fetch_audio_data(src: &str) -> Result<Arc<[u8]>, String> {
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

    pub fn rebuild_sink_from_state(&mut self, state: &EngineState) -> Result<(), String> {
        if self.active_output_mode == OutputMode::WasapiExclusive {
            self.prepare_exclusive_playback(state)?;
            if state.is_playing() {
                self.start_exclusive_playback()?;
            }
            return Ok(());
        }

        match self.shared_output_backend {
            SharedOutputBackend::Rodio => {
                let loaded_audio = self
                    .loaded_audio
                    .clone()
                    .ok_or_else(|| "No loaded audio is available.".to_string())?;

                let sink = self.create_sink()?;
                sink.set_volume(state.volume as f32);

                let decode_options = DecodePlaybackOptions {
                    start_at_seconds: state.current_time_seconds,
                    playback_rate: state.playback_rate,
                    loop_enabled: state.loop_enabled,
                };
                let decoded_stream = self
                    .decoder_backend
                    .decode_stream(loaded_audio.data.clone(), decode_options)?;
                let descriptor = decoded_stream.descriptor().clone();

                self.emit_decode_audit(
                    self.active_output_mode,
                    state.target_sample_rate_hz,
                    state.oversampling_filter_id.as_deref(),
                    &descriptor.source_info,
                    descriptor.conversion_path,
                    None,
                );
                decoded_stream.append_to_sink(&sink)?;

                self.stop_sink();
                self.sink = Some(sink);
            }
            SharedOutputBackend::Cpal => {
                if self.shared_cpal_output.is_none() {
                    self.initialize_output()?;
                }
                let (source_info, conversion_path, samples) = {
                    let decoded = self.get_or_decode_shared_pcm()?;
                    (
                        decoded.source_info.clone(),
                        decoded.conversion_path,
                        Arc::clone(&decoded.samples),
                    )
                };
                let track = SharedPcmTrack {
                    samples,
                    channels: source_info.channels,
                    sample_rate_hz: source_info.sample_rate_hz,
                };
                let conversion_path =
                    format!("{conversion_path}->cpal-callback-step-rate");

                self.emit_decode_audit(
                    self.active_output_mode,
                    state.target_sample_rate_hz,
                    state.oversampling_filter_id.as_deref(),
                    &source_info,
                    &conversion_path,
                    self.shared_underrun_count(),
                );

                self.stop_sink();
                let shared_output = self
                    .shared_cpal_output
                    .as_ref()
                    .ok_or_else(|| "Shared cpal output is not initialized.".to_string())?;
                shared_output.set_track(
                    track,
                    state.current_time_seconds,
                    state.playback_rate,
                    state.loop_enabled,
                    state.volume as f32,
                );
            }
        }

        Ok(())
    }

    pub fn play_sink(&mut self) {
        if self.active_output_mode == OutputMode::WasapiExclusive {
            let _ = self.start_exclusive_playback();
            return;
        }

        if let Some(shared_output) = &self.shared_cpal_output {
            shared_output.set_playing(true);
        }

        if let Some(sink) = &self.sink {
            sink.play();
        }
    }

    pub fn pause_sink(&mut self) {
        if self.active_output_mode == OutputMode::WasapiExclusive {
            self.stop_exclusive_playback();
            return;
        }

        if let Some(shared_output) = &self.shared_cpal_output {
            shared_output.set_playing(false);
        }

        if let Some(sink) = &self.sink {
            sink.pause();
        }
    }

    pub fn is_sink_empty(&mut self) -> bool {
        if self.active_output_mode == OutputMode::WasapiExclusive {
            self.cleanup_finished_exclusive_playback();
            return self.exclusive_playback_ended;
        }

        if let Some(shared_output) = &self.shared_cpal_output {
            return shared_output.is_ended();
        }

        self.sink.as_ref().map(|sink| sink.empty()).unwrap_or(false)
    }
}
