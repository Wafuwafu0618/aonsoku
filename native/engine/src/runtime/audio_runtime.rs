use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;

use url::Url;

use crate::audio::{
    probe_default_exclusive_open, run_default_exclusive_playback, ParametricEqConfig,
    SharedCpalOutput, SharedPcmTrack,
};
use crate::decoder::{
    default_decoder_backend, DecodedPcmData, DecodedSourceInfo, DecoderBackend,
};
use crate::engine::{EngineState, OutputMode};
use crate::error::RuntimeError;

const EXCLUSIVE_LOCK_FILE_NAME: &str = "aonsoku-native-audio-exclusive.lock";

#[derive(Clone)]
pub struct LoadedAudio {
    pub data: Arc<[u8]>,
}

#[derive(Clone)]
pub struct ExclusivePlaybackParams {
    pub audio_data: Arc<[u8]>,
    pub generation_id: u64,
    pub start_at_seconds: f64,
    pub playback_rate: f64,
    pub loop_enabled: bool,
    pub volume: f32,
    pub target_sample_rate_hz: Option<u32>,
    pub oversampling_filter_id: Option<String>,
    pub parametric_eq: Option<ParametricEqConfig>,
}

pub struct ExclusivePlaybackSession {
    pub generation_id: u64,
    pub stop_sender: mpsc::Sender<()>,
    pub started: Arc<AtomicBool>,
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

    pub fn is_started(&self) -> bool {
        self.started.load(Ordering::Relaxed)
    }

    pub fn ended_naturally(&self) -> bool {
        self.ended_naturally.load(Ordering::Relaxed)
    }
}

pub struct AudioRuntime {
    pub decoder_backend: Arc<dyn DecoderBackend>,
    pub shared_cpal_output: Option<SharedCpalOutput>,
    pub loaded_audio: Option<LoadedAudio>,
    pub loaded_source_info: Option<DecodedSourceInfo>,
    pub shared_decoded_pcm: Option<DecodedPcmData>,
    pub exclusive_prepared_playback: Option<ExclusivePlaybackParams>,
    pub exclusive_playback: Option<ExclusivePlaybackSession>,
    pub exclusive_playback_ended: bool,
    pub exclusive_generation_counter: u64,
    pub exclusive_lock: Option<File>,
    pub exclusive_lock_path: PathBuf,
    pub active_output_mode: OutputMode,
    pub exclusive_probe_verified: bool,
}

impl Default for AudioRuntime {
    fn default() -> Self {
        let decoder_backend = default_decoder_backend();
        eprintln!(
            "[NativeAudioSidecar][M2] decoder backend selected={}",
            decoder_backend.name()
        );
        eprintln!("[NativeAudioSidecar][M5] shared output backend fixed=cpal");

        Self {
            decoder_backend,
            shared_cpal_output: None,
            loaded_audio: None,
            loaded_source_info: None,
            shared_decoded_pcm: None,
            exclusive_prepared_playback: None,
            exclusive_playback: None,
            exclusive_playback_ended: false,
            exclusive_generation_counter: 0,
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
        if self.shared_cpal_output.is_some() {
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

        if self.shared_cpal_output.is_some() {
            return Ok(());
        }

        let output = SharedCpalOutput::new_default()?;
        eprintln!(
            "[NativeAudioSidecar][M3] shared cpal output initialized config={}",
            output.output_config_label()
        );
        self.shared_cpal_output = Some(output);
        Ok(())
    }

    pub fn initialize_shared_output_with_retry(&mut self) -> Result<(), String> {
        self.active_output_mode = OutputMode::WasapiShared;

        if let Err(first_error) = self.initialize_output() {
            self.shared_cpal_output = None;

            return self.initialize_output().map_err(|second_error| {
                format!("{first_error} (retry failed: {second_error})")
            });
        }

        Ok(())
    }

    pub fn stop_sink(&mut self) {
        self.stop_exclusive_playback("stop_sink");

        if let Some(shared_output) = &self.shared_cpal_output {
            shared_output.set_playing(false);
        }
    }

    pub fn clear_loaded_audio(&mut self) {
        self.stop_sink();
        self.loaded_audio = None;
        self.loaded_source_info = None;
        self.shared_decoded_pcm = None;
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

    fn stop_exclusive_playback(&mut self, reason: &str) {
        if let Some(mut session) = self.exclusive_playback.take() {
            eprintln!(
                "[NativeAudioSidecar] stop_exclusive_playback reason={} activeSession=true generation={}",
                reason,
                session.generation_id
            );
            session.request_stop();
            if let Some(handle) = session.join_handle.take() {
                let _ = handle.join();
            }
        } else {
            eprintln!(
                "[NativeAudioSidecar] stop_exclusive_playback reason={} activeSession=false",
                reason
            );
        }
        self.exclusive_playback_ended = false;
    }

    fn prepare_exclusive_playback(&mut self, state: &EngineState) -> Result<(), String> {
        let loaded_audio = self
            .loaded_audio
            .clone()
            .ok_or_else(|| "No loaded audio is available.".to_string())?;
        let source_info = if let Some(info) = self.loaded_source_info.clone() {
            info
        } else {
            self.inspect_source_info(loaded_audio.data.clone())?
        };
        let conversion_path =
            "symphonia:stream-decode-f32->exclusive-wasapi-worker";

        self.emit_decode_audit(
            OutputMode::WasapiExclusive,
            state.target_sample_rate_hz,
            state.oversampling_filter_id.as_deref(),
            &source_info,
            conversion_path,
            None,
        );

        self.stop_exclusive_playback("prepare_exclusive_playback");
        let generation_id = self.exclusive_generation_counter.saturating_add(1);
        self.exclusive_generation_counter = generation_id;
        eprintln!(
            "[NativeAudioSidecar] exclusive prepare generation={} startAt={:.3}s rate={:.3} loop={}",
            generation_id,
            state.current_time_seconds.max(0.0),
            state.playback_rate.max(0.01),
            state.loop_enabled
        );
        self.exclusive_prepared_playback = Some(ExclusivePlaybackParams {
            audio_data: loaded_audio.data,
            generation_id,
            start_at_seconds: state.current_time_seconds.max(0.0),
            playback_rate: state.playback_rate.max(0.01),
            loop_enabled: state.loop_enabled,
            volume: state.volume as f32,
            target_sample_rate_hz: state.target_sample_rate_hz,
            oversampling_filter_id: state.oversampling_filter_id.clone(),
            parametric_eq: state.parametric_eq.clone(),
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
        let started = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let ended_naturally = Arc::new(AtomicBool::new(false));
        self.exclusive_playback_ended = false;

        let generation_id = params.generation_id;
        let started_for_worker = Arc::clone(&started);
        let finished_for_worker = Arc::clone(&finished);
        let ended_naturally_for_worker = Arc::clone(&ended_naturally);

        let join_handle = thread::spawn(move || {
            let playback_result = run_default_exclusive_playback(
                params.audio_data,
                started_for_worker,
                params.start_at_seconds,
                params.playback_rate,
                params.loop_enabled,
                params.volume,
                params.target_sample_rate_hz,
                params.oversampling_filter_id,
                params.parametric_eq,
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

        eprintln!(
            "[NativeAudioSidecar] exclusive start generation={} mode={}",
            generation_id,
            self.active_output_mode.as_str()
        );
        self.exclusive_playback = Some(ExclusivePlaybackSession {
            generation_id,
            stop_sender,
            started,
            finished,
            ended_naturally,
            join_handle: Some(join_handle),
        });

        Ok(())
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
            let loaded_audio = self
                .loaded_audio
                .clone()
                .ok_or_else(|| "No loaded audio is available.".to_string())?;
            let decoded = self.decoder_backend.decode_pcm(loaded_audio.data)?;
            self.shared_decoded_pcm = Some(decoded);
        }

        self.shared_decoded_pcm
            .as_ref()
            .ok_or_else(|| "Shared PCM decode cache is unavailable.".to_string())
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
        let conversion_path = format!("{conversion_path}->cpal-callback-step-rate");

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

        Ok(())
    }

    pub fn play_sink_checked(&mut self) -> Result<(), String> {
        if self.active_output_mode == OutputMode::WasapiExclusive {
            self.start_exclusive_playback()?;
            return Ok(());
        }

        if let Some(shared_output) = &self.shared_cpal_output {
            shared_output.set_playing(true);
        }
        Ok(())
    }

    pub fn play_sink(&mut self) {
        let _ = self.play_sink_checked();
    }

    pub fn pause_sink(&mut self) {
        if self.active_output_mode == OutputMode::WasapiExclusive {
            self.stop_exclusive_playback("pause_sink");
            return;
        }

        if let Some(shared_output) = &self.shared_cpal_output {
            shared_output.set_playing(false);
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

        false
    }

    pub fn should_advance_playback_clock(&mut self, mode: OutputMode) -> bool {
        if mode != OutputMode::WasapiExclusive {
            return true;
        }

        self.cleanup_finished_exclusive_playback();
        self.exclusive_playback
            .as_ref()
            .map(|session| session.is_started())
            .unwrap_or(false)
    }
}
