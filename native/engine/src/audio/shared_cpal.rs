use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream};

#[derive(Clone)]
pub struct SharedPcmTrack {
    pub samples: Arc<[f32]>,
    pub channels: u16,
    pub sample_rate_hz: u32,
}

#[derive(Clone)]
struct SharedCpalState {
    track: Option<SharedPcmTrack>,
    cursor_frame: f64,
    playback_rate: f64,
    loop_enabled: bool,
    volume: f32,
    playing: bool,
    ended: bool,
    underrun_count: u64,
}

impl Default for SharedCpalState {
    fn default() -> Self {
        Self {
            track: None,
            cursor_frame: 0.0,
            playback_rate: 1.0,
            loop_enabled: false,
            volume: 1.0,
            playing: false,
            ended: false,
            underrun_count: 0,
        }
    }
}

pub struct SharedCpalOutput {
    _stream: Stream,
    state: Arc<Mutex<SharedCpalState>>,
    output_channels: u16,
    output_sample_rate_hz: u32,
}

impl SharedCpalOutput {
    pub fn new_default() -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| "Failed to open default output device.".to_string())?;
        let supported_config = device
            .default_output_config()
            .map_err(|error| format!("Failed to query default output config: {error}"))?;
        let output_channels = supported_config.channels();
        let output_sample_rate_hz = supported_config.sample_rate().0;
        let stream_config = supported_config.config();
        let sample_format = supported_config.sample_format();
        let state = Arc::new(Mutex::new(SharedCpalState::default()));
        let callback_state = Arc::clone(&state);

        let stream = match sample_format {
            SampleFormat::F32 => build_stream_f32(
                &device,
                &stream_config,
                callback_state,
                output_channels,
                output_sample_rate_hz,
            )?,
            SampleFormat::I16 => build_stream_i16(
                &device,
                &stream_config,
                callback_state,
                output_channels,
                output_sample_rate_hz,
            )?,
            SampleFormat::U16 => build_stream_u16(
                &device,
                &stream_config,
                callback_state,
                output_channels,
                output_sample_rate_hz,
            )?,
            other => {
                return Err(format!(
                    "Unsupported output sample format for shared cpal stream: {other:?}"
                ));
            }
        };

        stream
            .play()
            .map_err(|error| format!("Failed to start shared cpal stream: {error}"))?;

        Ok(Self {
            _stream: stream,
            state,
            output_channels,
            output_sample_rate_hz,
        })
    }

    pub fn set_track(
        &self,
        track: SharedPcmTrack,
        start_at_seconds: f64,
        playback_rate: f64,
        loop_enabled: bool,
        volume: f32,
    ) {
        let mut state = self.state.lock().expect("shared cpal state lock poisoned");
        let sample_rate_hz = track.sample_rate_hz;
        state.track = Some(track);
        state.playback_rate = sanitize_playback_rate(playback_rate);
        state.loop_enabled = loop_enabled;
        state.volume = sanitize_volume(volume);
        state.ended = false;
        state.playing = false;
        state.cursor_frame = position_to_cursor_frame(start_at_seconds, sample_rate_hz);
    }

    pub fn clear_track(&self) {
        let mut state = self.state.lock().expect("shared cpal state lock poisoned");
        state.track = None;
        state.cursor_frame = 0.0;
        state.playback_rate = 1.0;
        state.loop_enabled = false;
        state.playing = false;
        state.ended = false;
    }

    pub fn set_playing(&self, playing: bool) {
        let mut state = self.state.lock().expect("shared cpal state lock poisoned");
        if state.track.is_none() {
            state.playing = false;
            return;
        }
        state.playing = playing;
    }

    pub fn set_volume(&self, volume: f32) {
        let mut state = self.state.lock().expect("shared cpal state lock poisoned");
        state.volume = sanitize_volume(volume);
    }

    pub fn is_ended(&self) -> bool {
        self.state
            .lock()
            .expect("shared cpal state lock poisoned")
            .ended
    }

    pub fn underrun_count(&self) -> u64 {
        self.state
            .lock()
            .expect("shared cpal state lock poisoned")
            .underrun_count
    }

    pub fn output_config_label(&self) -> String {
        format!(
            "{}ch@{}Hz",
            self.output_channels, self.output_sample_rate_hz
        )
    }
}

fn build_stream_f32(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    state: Arc<Mutex<SharedCpalState>>,
    output_channels: u16,
    output_sample_rate_hz: u32,
) -> Result<Stream, String> {
    let err_fn = |error| {
        eprintln!("[NativeAudioSidecar] shared cpal stream error: {error}");
    };

    device
        .build_output_stream(
            config,
            move |data: &mut [f32], _| {
                render_buffer_f32(
                    data,
                    &state,
                    output_channels as usize,
                    output_sample_rate_hz,
                );
            },
            err_fn,
            None,
        )
        .map_err(|error| format!("Failed to build f32 shared cpal stream: {error}"))
}

fn build_stream_i16(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    state: Arc<Mutex<SharedCpalState>>,
    output_channels: u16,
    output_sample_rate_hz: u32,
) -> Result<Stream, String> {
    let err_fn = |error| {
        eprintln!("[NativeAudioSidecar] shared cpal stream error: {error}");
    };

    device
        .build_output_stream(
            config,
            move |data: &mut [i16], _| {
                render_buffer_i16(
                    data,
                    &state,
                    output_channels as usize,
                    output_sample_rate_hz,
                );
            },
            err_fn,
            None,
        )
        .map_err(|error| format!("Failed to build i16 shared cpal stream: {error}"))
}

fn build_stream_u16(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    state: Arc<Mutex<SharedCpalState>>,
    output_channels: u16,
    output_sample_rate_hz: u32,
) -> Result<Stream, String> {
    let err_fn = |error| {
        eprintln!("[NativeAudioSidecar] shared cpal stream error: {error}");
    };

    device
        .build_output_stream(
            config,
            move |data: &mut [u16], _| {
                render_buffer_u16(
                    data,
                    &state,
                    output_channels as usize,
                    output_sample_rate_hz,
                );
            },
            err_fn,
            None,
        )
        .map_err(|error| format!("Failed to build u16 shared cpal stream: {error}"))
}

fn render_buffer_f32(
    output: &mut [f32],
    state: &Arc<Mutex<SharedCpalState>>,
    output_channels: usize,
    output_sample_rate_hz: u32,
) {
    if output_channels == 0 {
        return;
    }

    let mut guard = state.lock().expect("shared cpal state lock poisoned");
    let track = guard.track.clone();
    for frame in output.chunks_mut(output_channels) {
        render_next_frame(
            &mut guard,
            track.as_ref(),
            output_sample_rate_hz,
            |value| value,
            frame,
        );
    }
}

fn render_buffer_i16(
    output: &mut [i16],
    state: &Arc<Mutex<SharedCpalState>>,
    output_channels: usize,
    output_sample_rate_hz: u32,
) {
    if output_channels == 0 {
        return;
    }

    let mut guard = state.lock().expect("shared cpal state lock poisoned");
    let track = guard.track.clone();
    for frame in output.chunks_mut(output_channels) {
        render_next_frame(
            &mut guard,
            track.as_ref(),
            output_sample_rate_hz,
            f32_to_i16,
            frame,
        );
    }
}

fn render_buffer_u16(
    output: &mut [u16],
    state: &Arc<Mutex<SharedCpalState>>,
    output_channels: usize,
    output_sample_rate_hz: u32,
) {
    if output_channels == 0 {
        return;
    }

    let mut guard = state.lock().expect("shared cpal state lock poisoned");
    let track = guard.track.clone();
    for frame in output.chunks_mut(output_channels) {
        render_next_frame(
            &mut guard,
            track.as_ref(),
            output_sample_rate_hz,
            f32_to_u16,
            frame,
        );
    }
}

fn render_next_frame<T, F>(
    state: &mut SharedCpalState,
    track: Option<&SharedPcmTrack>,
    output_sample_rate_hz: u32,
    to_output: F,
    output_frame: &mut [T],
) where
    F: Fn(f32) -> T,
{
    for sample in output_frame.iter_mut() {
        *sample = to_output(0.0);
    }

    if !state.playing {
        return;
    }

    let Some(track) = track else {
        state.underrun_count = state.underrun_count.saturating_add(1);
        return;
    };

    let source_channels = track.channels as usize;
    if source_channels == 0 || track.sample_rate_hz == 0 {
        state.playing = false;
        state.ended = true;
        state.underrun_count = state.underrun_count.saturating_add(1);
        return;
    }

    let total_frames = track.samples.len() / source_channels;
    if total_frames == 0 {
        state.playing = false;
        state.ended = true;
        return;
    }

    let mut source_frame_index = state.cursor_frame.floor().max(0.0) as usize;
    if source_frame_index >= total_frames {
        if state.loop_enabled {
            state.cursor_frame %= total_frames as f64;
            source_frame_index = state.cursor_frame.floor().max(0.0) as usize;
            if source_frame_index >= total_frames {
                source_frame_index = total_frames.saturating_sub(1);
            }
        } else {
            state.playing = false;
            state.ended = true;
            return;
        }
    }

    let source_frame_offset = source_frame_index.saturating_mul(source_channels);
    for (channel_index, sample_out) in output_frame.iter_mut().enumerate() {
        let source_sample = if source_channels == 1 {
            if channel_index < 2 {
                track.samples[source_frame_offset]
            } else {
                0.0
            }
        } else if channel_index < source_channels {
            track.samples[source_frame_offset + channel_index]
        } else {
            0.0
        };

        *sample_out = to_output(source_sample * state.volume);
    }

    let step = sanitize_playback_rate(state.playback_rate)
        * track.sample_rate_hz as f64
        / output_sample_rate_hz.max(1) as f64;
    state.cursor_frame += step;
    if !state.cursor_frame.is_finite() {
        state.cursor_frame = 0.0;
    }
}

fn position_to_cursor_frame(position_seconds: f64, sample_rate_hz: u32) -> f64 {
    let position = if position_seconds.is_finite() {
        position_seconds.max(0.0)
    } else {
        0.0
    };

    position * sample_rate_hz.max(1) as f64
}

fn sanitize_playback_rate(playback_rate: f64) -> f64 {
    if playback_rate.is_finite() {
        playback_rate.max(0.01)
    } else {
        1.0
    }
}

fn sanitize_volume(volume: f32) -> f32 {
    if volume.is_finite() {
        volume.clamp(0.0, 1.0)
    } else {
        1.0
    }
}

fn f32_to_i16(value: f32) -> i16 {
    let clamped = value.clamp(-1.0, 1.0);
    (clamped * i16::MAX as f32) as i16
}

fn f32_to_u16(value: f32) -> u16 {
    let clamped = value.clamp(-1.0, 1.0);
    ((clamped * 0.5 + 0.5) * u16::MAX as f32) as u16
}
