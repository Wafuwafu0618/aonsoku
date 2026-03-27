use std::io;
use std::time::Instant;

use crate::engine::{ensure_output_mode_supported, EngineState, OutputMode, PlaybackState};
use crate::protocol::{
    command_result_ok_value, emit_command_error, emit_response_ok, emit_simple_event,
    parse_params, LoadParams, NativeAudioDeviceInfo, NativeAudioInitializeResult,
    SeekParams, SetLoopParams, SetOutputModeParams, SetPlaybackRateParams,
    SetRelayPcmParams, SetVolumeParams, SidecarRequest,
};
use crate::runtime::{AudioRuntime, LoadedAudio, RemoteRelayPcmMode};

pub fn handle_command(
    request: SidecarRequest,
    state: &mut EngineState,
    runtime: &mut AudioRuntime,
) -> io::Result<()> {
    eprintln!(
        "[NativeAudioSidecar][cmd] id={} command={} mode={} playing={} hasSource={}",
        request.id,
        request.command,
        state.output_mode.as_str(),
        state.is_playing(),
        state.has_source()
    );

    match request.command.as_str() {
        "initialize" => {
            if let Err(error) = runtime.ensure_mode_resources(state.output_mode) {
                emit_command_error(
                    &request.id,
                    error.code,
                    &error.message,
                    Some(
                        serde_json::json!({
                            "mode": state.output_mode.as_str()
                        }),
                    ),
                )?;
                return Ok(());
            }

            runtime.active_output_mode = state.output_mode;

            if state.output_mode == OutputMode::WasapiShared {
                if let Err(message) = runtime.initialize_shared_output_with_retry() {
                    emit_command_error(&request.id, "output-init-failed", &message, None)?;
                    return Ok(());
                }
            } else {
                runtime.reset_output_device();
                runtime.active_output_mode = state.output_mode;
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
            let mut devices = vec![NativeAudioDeviceInfo {
                id: "default-shared".to_string(),
                name: "Default Device (Shared)".to_string(),
                mode: OutputMode::WasapiShared.as_str().to_string(),
                is_default: true,
            }];

            // Expose exclusive capability on Windows even when temporarily unavailable.
            // Runtime availability is validated by setOutputMode/load and can recover.
            if cfg!(target_os = "windows") {
                devices.push(NativeAudioDeviceInfo {
                    id: "default-exclusive".to_string(),
                    name: "Default Device (Exclusive)".to_string(),
                    mode: OutputMode::WasapiExclusive.as_str().to_string(),
                    is_default: true,
                });
            }

            emit_response_ok(
                &request.id,
                Some(serde_json::to_value(devices).unwrap_or_else(|_| serde_json::json!([]))),
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
                        return Ok(());
                    }
                };

                if mode == OutputMode::Asio {
                    emit_command_error(
                        &request.id,
                        "unsupported-output-mode",
                        "Current build does not support ASIO output mode yet.",
                        Some(
                            serde_json::json!({
                                "mode": mode.as_str(),
                                "supportedModes": ["wasapi-shared", "wasapi-exclusive"]
                            }),
                        ),
                    )?;
                    return Ok(());
                }

                if let Err(error) = runtime.configure_output_mode(mode) {
                    emit_command_error(
                        &request.id,
                        error.code,
                        &error.message,
                        Some(serde_json::json!({
                            "mode": mode.as_str()
                        })),
                    )?;
                    return Ok(());
                }

                state.output_mode = mode;

                if state.has_source() {
                    if let Err(message) = runtime.rebuild_sink_from_state(state) {
                        emit_command_error(
                            &request.id,
                            "playback-pipeline-failed",
                            &message,
                            None,
                        )?;
                        return Ok(());
                    }

                    if state.is_playing() {
                        if let Err(message) = runtime.play_sink_checked() {
                            state.pause_playback();
                            state.last_tick_instant = None;
                            emit_command_error(
                                &request.id,
                                "playback-pipeline-failed",
                                &message,
                                None,
                            )?;
                            return Ok(());
                        }
                        state.last_tick_instant = Some(Instant::now());
                    } else {
                        runtime.pause_sink();
                        state.last_tick_instant = None;
                    }
                }

                emit_simple_event("deviceChanged", None, None)?;
                emit_response_ok(&request.id, Some(command_result_ok_value()))?;
            }
            Err(message) => {
                emit_command_error(&request.id, "invalid-params", &message, None)?;
            }
        },
        "setRelayPcm" => match parse_params::<SetRelayPcmParams>(request.params) {
            Ok(params) => {
                let mode = match params.mode.as_deref().unwrap_or("tap") {
                    "tap" => RemoteRelayPcmMode::Tap,
                    "streamOnly" => RemoteRelayPcmMode::StreamOnly,
                    _ => {
                        emit_command_error(
                            &request.id,
                            "invalid-params",
                            "setRelayPcm mode must be one of tap / streamOnly.",
                            None,
                        )?;
                        return Ok(());
                    }
                };

                runtime.set_remote_relay_pcm(params.enabled, mode);
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
                return Ok(());
            }

            if !ensure_output_mode_supported(state, &request.id)? {
                return Ok(());
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
                        return Ok(());
                    }

                    if let Some(start_at_seconds) = params.start_at_seconds {
                        if !start_at_seconds.is_finite() || start_at_seconds < 0.0 {
                            emit_command_error(
                                &request.id,
                                "invalid-start-position",
                                "startAtSeconds must be a finite number >= 0.",
                                None,
                            )?;
                            return Ok(());
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
                            return Ok(());
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
                            return Ok(());
                        }
                    }

                    if let Some(target_sample_rate_hz) = params.target_sample_rate_hz {
                        if target_sample_rate_hz < 8_000 {
                            emit_command_error(
                                &request.id,
                                "invalid-target-sample-rate",
                                "targetSampleRateHz must be >= 8000 when provided.",
                                Some(
                                    serde_json::json!({
                                        "targetSampleRateHz": target_sample_rate_hz
                                    }),
                                ),
                            )?;
                            return Ok(());
                        }
                    }

                    let mut requested_parametric_eq = params.parametric_eq.clone();
                    if let Some(parametric_eq) = requested_parametric_eq.as_ref() {
                        if let Err(message) = parametric_eq.validate() {
                            emit_command_error(
                                &request.id,
                                "invalid-parametric-eq",
                                message,
                                None,
                            )?;
                            return Ok(());
                        }

                        let has_enabled_bands =
                            parametric_eq.bands.iter().any(|band| band.enabled);
                        let has_preamp = parametric_eq.preamp_db.abs() > f32::EPSILON;
                        if !has_enabled_bands && !has_preamp {
                            requested_parametric_eq = None;
                        }
                    }

                    let requested_playback_rate = params.playback_rate.unwrap_or(1.0);
                    let requested_loop = params.loop_value;
                    let requested_start = params.start_at_seconds.unwrap_or(0.0);
                    let no_explicit_seek = params.start_at_seconds.is_none();
                    let requested_oversampling_filter_id = params
                        .oversampling_filter_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string);

                    let same_loaded_source = runtime.loaded_audio.is_some()
                        && state.source.as_deref() == Some(params.src.as_str())
                        && state.target_sample_rate_hz == params.target_sample_rate_hz
                        && state.oversampling_filter_id.as_deref()
                            == requested_oversampling_filter_id.as_deref()
                        && state.parametric_eq == requested_parametric_eq
                        && state.loop_enabled == requested_loop
                        && (state.playback_rate - requested_playback_rate).abs() < f64::EPSILON;

                    if same_loaded_source && no_explicit_seek {
                        if params.autoplay {
                            if !state.is_playing() {
                                if let Err((code, message)) = state.start_playback() {
                                    emit_command_error(&request.id, code, message, None)?;
                                    return Ok(());
                                }
                                if let Err(message) = runtime.play_sink_checked() {
                                    state.pause_playback();
                                    state.last_tick_instant = None;
                                    emit_command_error(
                                        &request.id,
                                        "playback-pipeline-failed",
                                        &message,
                                        None,
                                    )?;
                                    return Ok(());
                                }
                                emit_simple_event("play", None, None)?;
                            }
                        } else if state.is_playing() {
                            state.pause_playback();
                            runtime.pause_sink();
                            emit_simple_event("pause", None, None)?;
                        }

                        emit_response_ok(&request.id, Some(command_result_ok_value()))?;
                        return Ok(());
                    }

                    // Stop current playback immediately when switching tracks.
                    // This avoids leaking previous track audio during load/fetch.
                    if state.has_source() {
                        state.pause_playback();
                        runtime.stop_sink();
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
                            return Ok(());
                        }
                    };

                    let inspected_source = runtime.inspect_source_info(audio_data.clone());
                    let inspected_source_info = inspected_source.as_ref().ok().cloned();
                    if let Ok(source_info) = inspected_source.as_ref() {
                        runtime.emit_decode_audit(
                            state.output_mode,
                            params.target_sample_rate_hz,
                            requested_oversampling_filter_id.as_deref(),
                            source_info,
                            "inspect-only",
                            None,
                        );
                    }

                    let duration_seconds = if let Some(duration) = params.duration_seconds {
                        duration
                    } else {
                        match inspected_source {
                            Ok(source_info) => source_info.duration_seconds,
                            Err(message) => {
                                emit_command_error(
                                    &request.id,
                                    "source-decode-failed",
                                    &message,
                                    None,
                                )?;
                                return Ok(());
                            }
                        }
                    };

                    if let Err(error) = runtime.ensure_mode_resources(state.output_mode) {
                        emit_command_error(
                            &request.id,
                            error.code,
                            &error.message,
                            Some(
                                serde_json::json!({
                                    "mode": state.output_mode.as_str()
                                }),
                            ),
                        )?;
                        return Ok(());
                    }

                    runtime.active_output_mode = state.output_mode;

                    if state.output_mode == OutputMode::WasapiShared {
                        if let Err(message) = runtime.initialize_shared_output_with_retry() {
                            emit_command_error(&request.id, "output-init-failed", &message, None)?;
                            return Ok(());
                        }
                    } else {
                        runtime.reset_output_device();
                        runtime.active_output_mode = state.output_mode;
                    }

                    state.source = Some(params.src);
                    state.playback_state = PlaybackState::Ready;
                    state.loop_enabled = requested_loop;
                    state.playback_rate = requested_playback_rate;
                    state.duration_seconds = duration_seconds;
                    state.target_sample_rate_hz = params.target_sample_rate_hz;
                    state.oversampling_filter_id = requested_oversampling_filter_id;
                    state.parametric_eq = requested_parametric_eq;
                    state.set_current_time(requested_start);
                    state.last_tick_instant = None;

                    runtime.loaded_audio = Some(LoadedAudio { data: audio_data });
                    runtime.loaded_source_info = inspected_source_info;
                    runtime.shared_decoded_pcm = None;

                    if let Err(message) = runtime.rebuild_sink_from_state(state) {
                        emit_command_error(
                            &request.id,
                            "playback-pipeline-failed",
                            &message,
                            None,
                        )?;
                        return Ok(());
                    }

                    emit_simple_event(
                        "loadedmetadata",
                        Some(state.current_time_seconds),
                        Some(state.duration_seconds),
                    )?;

                    if params.autoplay {
                        if let Err((code, message)) = state.start_playback() {
                            emit_command_error(&request.id, code, message, None)?;
                            return Ok(());
                        }
                        if let Err(message) = runtime.play_sink_checked() {
                            state.pause_playback();
                            state.last_tick_instant = None;
                            emit_command_error(
                                &request.id,
                                "playback-pipeline-failed",
                                &message,
                                None,
                            )?;
                            return Ok(());
                        }
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
                return Ok(());
            }

            if !ensure_output_mode_supported(state, &request.id)? {
                return Ok(());
            }

            if state.is_playing() {
                emit_response_ok(&request.id, Some(command_result_ok_value()))?;
                return Ok(());
            }

            match state.start_playback() {
                Ok(()) => {
                    if let Err(message) = runtime.rebuild_sink_from_state(state) {
                        emit_command_error(
                            &request.id,
                            "playback-pipeline-failed",
                            &message,
                            None,
                        )?;
                        return Ok(());
                    }
                    if let Err(message) = runtime.play_sink_checked() {
                        state.pause_playback();
                        state.last_tick_instant = None;
                        emit_command_error(
                            &request.id,
                            "playback-pipeline-failed",
                            &message,
                            None,
                        )?;
                        return Ok(());
                    }
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
                return Ok(());
            }

            if !ensure_output_mode_supported(state, &request.id)? {
                return Ok(());
            }

            if !state.has_source() {
                emit_command_error(
                    &request.id,
                    "no-source",
                    "No audio source has been loaded.",
                    None,
                )?;
                return Ok(());
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
                return Ok(());
            }

            if !ensure_output_mode_supported(state, &request.id)? {
                return Ok(());
            }

            if !state.has_source() {
                emit_command_error(
                    &request.id,
                    "no-source",
                    "No audio source has been loaded.",
                    None,
                )?;
                return Ok(());
            }

            match parse_params::<SeekParams>(request.params) {
                Ok(params) => {
                    if !params.position_seconds.is_finite() || params.position_seconds < 0.0 {
                        emit_command_error(
                            &request.id,
                            "invalid-seek-position",
                            "Seek position must be a finite number >= 0.",
                            None,
                        )?;
                        return Ok(());
                    }

                    if state.is_playing() {
                        state.advance_clock();
                    }

                    state.set_current_time(params.position_seconds);
                    if state.playback_state == PlaybackState::Ended {
                        state.playback_state = PlaybackState::Paused;
                    }

                    if let Err(message) = runtime.rebuild_sink_from_state(state) {
                        emit_command_error(
                            &request.id,
                            "playback-pipeline-failed",
                            &message,
                            None,
                        )?;
                        return Ok(());
                    }

                    if state.is_playing() {
                        if let Err(message) = runtime.play_sink_checked() {
                            state.pause_playback();
                            state.last_tick_instant = None;
                            emit_command_error(
                                &request.id,
                                "playback-pipeline-failed",
                                &message,
                                None,
                            )?;
                            return Ok(());
                        }
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
                    return Ok(());
                }

                state.volume = params.volume;
                if runtime.active_output_mode == OutputMode::WasapiExclusive {
                    if state.has_source() {
                        if !state.is_playing() {
                            if let Err(message) = runtime.rebuild_sink_from_state(state) {
                                emit_command_error(
                                    &request.id,
                                    "playback-pipeline-failed",
                                    &message,
                                    None,
                                )?;
                                return Ok(());
                            }
                        } else if let Some(prepared) = runtime.exclusive_prepared_playback.as_mut()
                        {
                            prepared.volume = state.volume as f32;
                        }
                    }
                } else {
                    runtime.set_shared_volume(params.volume as f32);
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
                    if let Err(message) = runtime.rebuild_sink_from_state(state) {
                        emit_command_error(
                            &request.id,
                            "playback-pipeline-failed",
                            &message,
                            None,
                        )?;
                        return Ok(());
                    }

                    if state.is_playing() {
                        if let Err(message) = runtime.play_sink_checked() {
                            state.pause_playback();
                            state.last_tick_instant = None;
                            emit_command_error(
                                &request.id,
                                "playback-pipeline-failed",
                                &message,
                                None,
                            )?;
                            return Ok(());
                        }
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
        "setPlaybackRate" => match parse_params::<SetPlaybackRateParams>(request.params) {
            Ok(params) => {
                if !params.playback_rate.is_finite() || params.playback_rate <= 0.0 {
                    emit_command_error(
                        &request.id,
                        "invalid-playback-rate",
                        "Playback rate must be a finite number > 0.",
                        None,
                    )?;
                    return Ok(());
                }

                if state.is_playing() {
                    state.advance_clock();
                }

                state.playback_rate = params.playback_rate;

                if state.has_source() {
                    if let Err(message) = runtime.rebuild_sink_from_state(state) {
                        emit_command_error(
                            &request.id,
                            "playback-pipeline-failed",
                            &message,
                            None,
                        )?;
                        return Ok(());
                    }

                    if state.is_playing() {
                        if let Err(message) = runtime.play_sink_checked() {
                            state.pause_playback();
                            state.last_tick_instant = None;
                            emit_command_error(
                                &request.id,
                                "playback-pipeline-failed",
                                &message,
                                None,
                            )?;
                            return Ok(());
                        }
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
        "dispose" => {
            runtime.set_remote_relay_pcm(false, RemoteRelayPcmMode::Tap);
            runtime.clear_loaded_audio();
            runtime.reset_output_device();
            if state.output_mode == OutputMode::WasapiExclusive {
                runtime.release_exclusive_lock();
            }
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

    Ok(())
}
