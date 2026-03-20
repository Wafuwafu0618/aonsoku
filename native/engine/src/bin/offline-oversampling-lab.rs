use std::collections::BTreeSet;
use std::f64::consts::PI;
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use serde::Serialize;
use url::Url;

#[path = "../audio/parametric_eq.rs"]
mod parametric_eq;
#[path = "../decoder/mod.rs"]
mod decoder;

use decoder::{DecodedPcmData, DecodedSourceInfo};
use parametric_eq::{ParametricEqConfig, ParametricEqProcessor};

const HQ_RESAMPLER_CHUNK_FRAMES: usize = 512;
const HQ_RESAMPLER_OUTPUT_HEADROOM_GAIN: f32 = 0.89;
const DEFAULT_MAX_LAG_FRAMES: usize = 2048;
const DEFAULT_LAG_WINDOW_FRAMES: usize = 48_000;
const DEFAULT_IMPULSE_FRAMES: usize = 65_536;

#[derive(Debug, Clone)]
struct CliArgs {
    src: String,
    filters: Vec<String>,
    target_sample_rate_hz: Option<u32>,
    output_dir: Option<PathBuf>,
    write_wav: bool,
    volume: f32,
    reference_filter: Option<String>,
    max_lag_frames: usize,
    lag_window_frames: usize,
    parametric_eq_json: Option<PathBuf>,
    self_null: bool,
    analyze_impulse: bool,
    impulse_frames: usize,
    write_impulse_wav: bool,
    stopband_start_hz: Option<f64>,
}

#[derive(Debug, Clone)]
struct RenderedCase {
    filter_token: String,
    filter_id: Option<String>,
    profile_label: Option<String>,
    output_sample_rate_hz: u32,
    channels: u16,
    samples: Vec<f32>,
    processing_time_ms: f64,
    wav_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseMetrics {
    filter_token: String,
    filter_id: Option<String>,
    profile_label: Option<String>,
    output_sample_rate_hz: u32,
    channels: u16,
    frames: usize,
    duration_seconds: f64,
    processing_time_ms: f64,
    peak_dbfs: f64,
    true_peak_dbfs: f64,
    rms_dbfs: f64,
    crest_factor_db: f64,
    clip_samples: u64,
    clip_ratio: f64,
    wav_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComparisonMetrics {
    filter_token: String,
    reference_filter_token: String,
    lag_frames: i32,
    overlap_frames: usize,
    residual_peak_dbfs: f64,
    residual_rms_dbfs: f64,
    residual_rms_relative_db: f64,
    correlation: f64,
    level_delta_db: f64,
    gain_matched_scale: f64,
    gain_matched_scale_db: f64,
    gain_matched_phase_inverted: bool,
    residual_rms_dbfs_gain_matched: f64,
    residual_rms_relative_db_gain_matched: f64,
    gain_matched_snr_db: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelfNullMetrics {
    filter_token: String,
    output_sample_rate_hz: u32,
    lag_frames: i32,
    overlap_frames: usize,
    residual_peak_dbfs: f64,
    residual_rms_dbfs: f64,
    residual_rms_relative_db: f64,
    residual_rms_relative_db_gain_matched: f64,
    gain_matched_snr_db: f64,
    bit_exact: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImpulseAnalysisMetrics {
    filter_token: String,
    filter_id: Option<String>,
    profile_label: Option<String>,
    output_sample_rate_hz: u32,
    channels: u16,
    impulse_input_frames: usize,
    impulse_output_frames: usize,
    fft_size: usize,
    effective_nyquist_hz: f64,
    passband_end_hz: f64,
    passband_peak_db: f64,
    stopband_start_hz: Option<f64>,
    stopband_end_hz: Option<f64>,
    stopband_peak_db: Option<f64>,
    stopband_attenuation_db: Option<f64>,
    impulse_wav_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineLabReport {
    source: String,
    source_sample_rate_hz: u32,
    source_channels: u16,
    source_duration_seconds: f64,
    target_sample_rate_hz: u32,
    write_wav: bool,
    output_dir: Option<String>,
    notes: Vec<String>,
    cases: Vec<CaseMetrics>,
    comparisons: Vec<ComparisonMetrics>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    self_nulls: Vec<SelfNullMetrics>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    impulse_analyses: Vec<ImpulseAnalysisMetrics>,
}

#[derive(Clone, Copy, Debug)]
enum HqResamplerProfile {
    ShortMp,
    Mp,
    Lp,
    LongLp,
}

impl HqResamplerProfile {
    fn from_filter_id(filter_id: Option<&str>) -> (Self, bool) {
        match filter_id {
            Some("poly-sinc-short-mp") => (Self::ShortMp, true),
            Some("poly-sinc-mp") => (Self::Mp, true),
            Some("poly-sinc-lp") => (Self::Lp, true),
            Some("poly-sinc-long-lp") | Some("poly-sinc-long-ip") => (Self::LongLp, true),
            Some(_) => (Self::Mp, false),
            None => (Self::Mp, true),
        }
    }

    fn as_label(self) -> &'static str {
        match self {
            Self::ShortMp => "poly-sinc-short-mp",
            Self::Mp => "poly-sinc-mp",
            Self::Lp => "poly-sinc-lp",
            Self::LongLp => "poly-sinc-long-lp",
        }
    }
}

fn build_hq_resampler_params(
    profile: HqResamplerProfile,
    ratio: f64,
) -> SincInterpolationParameters {
    let (sinc_len, f_cutoff, oversampling_factor): (usize, f32, usize) = match profile {
        HqResamplerProfile::ShortMp => {
            if ratio >= 8.0 {
                (18, 0.885, 4)
            } else if ratio >= 4.0 {
                (20, 0.890, 5)
            } else {
                (24, 0.900, 6)
            }
        }
        HqResamplerProfile::Mp => {
            if ratio >= 8.0 {
                (32, 0.915, 6)
            } else if ratio >= 4.0 {
                (36, 0.925, 7)
            } else {
                (44, 0.935, 8)
            }
        }
        HqResamplerProfile::Lp => {
            if ratio >= 8.0 {
                (56, 0.945, 8)
            } else if ratio >= 4.0 {
                (72, 0.952, 10)
            } else {
                (88, 0.958, 12)
            }
        }
        HqResamplerProfile::LongLp => {
            if ratio >= 8.0 {
                (512, 0.968, 64)
            } else if ratio >= 4.0 {
                (256, 0.968, 32)
            } else {
                (192, 0.968, 20)
            }
        }
    };

    SincInterpolationParameters {
        sinc_len,
        f_cutoff: f_cutoff.clamp(0.82, 0.98),
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: oversampling_factor.max(4),
        window: WindowFunction::BlackmanHarris2,
    }
}

fn classify_sample_rate_family(sample_rate: u32) -> Option<u32> {
    if sample_rate == 0 {
        return None;
    }
    if sample_rate % 44_100 == 0 {
        return Some(44_100);
    }
    if sample_rate % 48_000 == 0 {
        return Some(48_000);
    }
    None
}

fn normalize_target_sample_rate_for_source(source_sample_rate: u32, requested_target: u32) -> u32 {
    if source_sample_rate == 0 || requested_target == 0 {
        return requested_target;
    }

    let source_family = classify_sample_rate_family(source_sample_rate);
    let target_family = classify_sample_rate_family(requested_target);

    match (source_family, target_family) {
        (Some(source_family), Some(target_family)) if source_family != target_family => {
            let adjusted = (requested_target as u64)
                .saturating_mul(source_family as u64)
                .checked_div(target_family as u64)
                .unwrap_or(requested_target as u64);

            if adjusted == 0 || adjusted > u32::MAX as u64 {
                requested_target
            } else {
                adjusted as u32
            }
        }
        _ => requested_target,
    }
}

fn deinterleave(interleaved: &[f32], channels: usize) -> Vec<Vec<f32>> {
    let frames = if channels == 0 {
        0
    } else {
        interleaved.len() / channels
    };
    let mut out = vec![Vec::<f32>::with_capacity(frames); channels];
    for frame in interleaved.chunks_exact(channels) {
        for (channel, sample) in frame.iter().enumerate() {
            out[channel].push(*sample);
        }
    }
    out
}

fn interleave(channels: &[Vec<f32>]) -> Vec<f32> {
    if channels.is_empty() {
        return Vec::new();
    }
    let frames = channels[0].len();
    let channel_count = channels.len();
    let mut out = Vec::<f32>::with_capacity(frames.saturating_mul(channel_count));
    for frame_idx in 0..frames {
        for channel in channels {
            out.push(channel.get(frame_idx).copied().unwrap_or(0.0));
        }
    }
    out
}

fn append_resampler_output(
    output_by_channel: &mut [Vec<f32>],
    processed: &[Vec<f32>],
    expected_max_output_frames: usize,
) -> Result<(), String> {
    if processed.is_empty() || processed[0].is_empty() {
        return Ok(());
    }

    let channels = output_by_channel.len();
    if processed.len() != channels {
        return Err(format!(
            "HQ resampler returned unexpected channel count: expected {channels}, got {}",
            processed.len()
        ));
    }

    for channel in 0..channels {
        output_by_channel[channel].extend_from_slice(&processed[channel]);
        if output_by_channel[channel].len() > expected_max_output_frames {
            return Err(format!(
                "HQ resampler produced excessive output (>{expected_max_output_frames} frames per channel). Aborting to prevent memory runaway."
            ));
        }
    }

    Ok(())
}

fn resample_interleaved(
    input_samples: &[f32],
    channels: usize,
    input_sample_rate_hz: u32,
    output_sample_rate_hz: u32,
    profile: HqResamplerProfile,
) -> Result<Vec<f32>, String> {
    if channels == 0 {
        return Ok(Vec::new());
    }
    if input_sample_rate_hz == 0 || output_sample_rate_hz == 0 {
        return Err("Sample rate must be greater than zero.".to_string());
    }
    if input_sample_rate_hz == output_sample_rate_hz {
        return Ok(input_samples.to_vec());
    }

    let ratio = output_sample_rate_hz as f64 / input_sample_rate_hz as f64;
    let params = build_hq_resampler_params(profile, ratio);
    let mut resampler = SincFixedIn::<f32>::new(
        ratio,
        2.0,
        params,
        HQ_RESAMPLER_CHUNK_FRAMES,
        channels,
    )
    .map_err(|error| format!("Failed to initialize HQ resampler: {error}"))?;

    let input_by_channel = deinterleave(input_samples, channels);
    let total_input_frames = input_by_channel[0].len();
    let expected_frames = (total_input_frames as f64 * ratio).ceil() as usize;
    // Allow generous headroom for ratio drift and filter tail while still
    // catching runaway growth.
    let extra_guard_frames = (HQ_RESAMPLER_CHUNK_FRAMES * 256)
        .max(output_sample_rate_hz as usize * 4);
    let expected_max_output_frames = expected_frames.saturating_add(extra_guard_frames);
    let mut cursor = 0usize;
    let mut output_by_channel = vec![Vec::<f32>::new(); channels];
    let mut chunk = vec![Vec::<f32>::with_capacity(HQ_RESAMPLER_CHUNK_FRAMES); channels];

    while cursor + HQ_RESAMPLER_CHUNK_FRAMES <= total_input_frames {
        for channel in 0..channels {
            chunk[channel].clear();
            chunk[channel].extend_from_slice(
                &input_by_channel[channel][cursor..cursor + HQ_RESAMPLER_CHUNK_FRAMES],
            );
        }
        let processed = resampler
            .process(&chunk, None)
            .map_err(|error| format!("Failed to process HQ resampler chunk: {error}"))?;
        append_resampler_output(&mut output_by_channel, &processed, expected_max_output_frames)?;
        cursor += HQ_RESAMPLER_CHUNK_FRAMES;
    }

    if cursor < total_input_frames {
        for channel in 0..channels {
            chunk[channel].clear();
            chunk[channel].extend_from_slice(&input_by_channel[channel][cursor..]);
        }
        let processed = resampler
            .process_partial(Some(&chunk), None)
            .map_err(|error| format!("Failed to process final HQ resampler chunk: {error}"))?;
        append_resampler_output(&mut output_by_channel, &processed, expected_max_output_frames)?;
    }

    let tail = resampler
        .process_partial(None::<&[Vec<f32>]>, None)
        .map_err(|error| format!("Failed to flush HQ resampler tail: {error}"))?;
    append_resampler_output(&mut output_by_channel, &tail, expected_max_output_frames)?;

    Ok(interleave(&output_by_channel))
}

fn dbfs_from_amplitude(value: f64) -> f64 {
    if value <= 0.0 {
        f64::NEG_INFINITY
    } else {
        20.0 * value.log10()
    }
}

fn compute_peak(samples: &[f32]) -> f64 {
    samples
        .iter()
        .map(|sample| (*sample as f64).abs())
        .fold(0.0_f64, f64::max)
}

fn compute_rms(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let power = samples
        .iter()
        .map(|sample| {
            let value = *sample as f64;
            value * value
        })
        .sum::<f64>()
        / samples.len() as f64;
    power.sqrt()
}

fn compute_true_peak_linear_4x(samples: &[f32], channels: usize) -> f64 {
    if samples.is_empty() || channels == 0 {
        return 0.0;
    }
    let frames = samples.len() / channels;
    if frames == 0 {
        return 0.0;
    }

    let mut peak = 0.0_f64;
    for channel in 0..channels {
        for frame in 0..frames {
            let base = samples[frame * channels + channel] as f64;
            peak = peak.max(base.abs());

            if frame + 1 >= frames {
                continue;
            }

            let next = samples[(frame + 1) * channels + channel] as f64;
            for step in 1..4 {
                let t = step as f64 / 4.0;
                let value = (1.0 - t) * base + t * next;
                peak = peak.max(value.abs());
            }
        }
    }
    peak
}

fn compute_clip_count(samples: &[f32]) -> u64 {
    samples
        .iter()
        .filter(|sample| sample.abs() > 1.0_f32)
        .count() as u64
}

#[derive(Debug, Clone, Copy, Default)]
struct ComplexF64 {
    re: f64,
    im: f64,
}

impl ComplexF64 {
    fn new(re: f64, im: f64) -> Self {
        Self { re, im }
    }

    fn magnitude(self) -> f64 {
        (self.re * self.re + self.im * self.im).sqrt()
    }

    fn mul(self, other: Self) -> Self {
        Self {
            re: self.re * other.re - self.im * other.im,
            im: self.re * other.im + self.im * other.re,
        }
    }
}

#[derive(Debug, Clone)]
struct ImpulseSpectrumStats {
    fft_size: usize,
    effective_nyquist_hz: f64,
    passband_end_hz: f64,
    passband_peak_db: f64,
    stopband_start_hz: Option<f64>,
    stopband_end_hz: Option<f64>,
    stopband_peak_db: Option<f64>,
    stopband_attenuation_db: Option<f64>,
}

fn fft_in_place(buffer: &mut [ComplexF64]) -> Result<(), String> {
    let n = buffer.len();
    if n == 0 || !n.is_power_of_two() {
        return Err("FFT input length must be a non-zero power of two.".to_string());
    }

    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            buffer.swap(i, j);
        }
    }

    let mut len = 2usize;
    while len <= n {
        let half = len / 2;
        let angle = -2.0 * PI / len as f64;
        let w_len = ComplexF64::new(angle.cos(), angle.sin());

        for start in (0..n).step_by(len) {
            let mut w = ComplexF64::new(1.0, 0.0);
            for offset in 0..half {
                let even = buffer[start + offset];
                let odd = buffer[start + offset + half].mul(w);
                buffer[start + offset] = ComplexF64::new(even.re + odd.re, even.im + odd.im);
                buffer[start + offset + half] =
                    ComplexF64::new(even.re - odd.re, even.im - odd.im);
                w = w.mul(w_len);
            }
        }

        len <<= 1;
    }

    Ok(())
}

fn build_synthetic_impulse_source(
    source_sample_rate_hz: u32,
    channels: u16,
    frames: usize,
) -> Result<DecodedPcmData, String> {
    if source_sample_rate_hz == 0 {
        return Err("Impulse source sample rate must be greater than zero.".to_string());
    }
    if channels == 0 {
        return Err("Impulse source channels must be greater than zero.".to_string());
    }
    if frames == 0 {
        return Err("Impulse source frames must be greater than zero.".to_string());
    }

    let total_samples = frames
        .checked_mul(channels as usize)
        .ok_or_else(|| "Impulse source sample length overflow.".to_string())?;
    let mut samples = vec![0.0_f32; total_samples];
    let impulse_frame = frames / 2;
    for channel in 0..channels as usize {
        samples[impulse_frame * channels as usize + channel] = 1.0;
    }

    Ok(DecodedPcmData {
        source_info: DecodedSourceInfo {
            channels,
            sample_rate_hz: source_sample_rate_hz,
            duration_seconds: frames as f64 / source_sample_rate_hz as f64,
        },
        samples: Arc::<[f32]>::from(samples),
        conversion_path: "synthetic-impulse",
    })
}

fn analyze_impulse_spectrum(
    samples: &[f32],
    channels: usize,
    source_sample_rate_hz: u32,
    output_sample_rate_hz: u32,
    stopband_start_hz_override: Option<f64>,
) -> Result<ImpulseSpectrumStats, String> {
    if channels == 0 {
        return Err("Impulse analysis requires at least one channel.".to_string());
    }
    if source_sample_rate_hz == 0 || output_sample_rate_hz == 0 {
        return Err("Impulse analysis requires valid sample rates.".to_string());
    }
    if samples.len() < channels {
        return Err("Impulse analysis requires non-empty sample data.".to_string());
    }

    let frames = samples.len() / channels;
    if frames == 0 {
        return Err("Impulse analysis requires at least one frame.".to_string());
    }

    let fft_size = frames.next_power_of_two().max(2048);
    if fft_size > (1 << 20) {
        return Err(format!(
            "Impulse response is too long for FFT analysis ({} frames > supported limit).",
            frames
        ));
    }

    let mut fft_input = vec![ComplexF64::default(); fft_size];
    for frame in 0..frames {
        fft_input[frame] = ComplexF64::new(samples[frame * channels] as f64, 0.0);
    }
    fft_in_place(&mut fft_input)?;

    let output_nyquist_hz = output_sample_rate_hz as f64 * 0.5;
    let effective_nyquist_hz =
        (source_sample_rate_hz.min(output_sample_rate_hz)) as f64 * 0.5;
    let passband_end_hz = (effective_nyquist_hz * 0.95).min(output_nyquist_hz);

    let bin_hz = output_sample_rate_hz as f64 / fft_size as f64;
    let half_bins = fft_size / 2;
    let passband_end_bin = ((passband_end_hz / bin_hz).floor() as usize).min(half_bins);
    let mut passband_peak = 0.0_f64;
    for bin in 0..=passband_end_bin {
        let magnitude = fft_input[bin].magnitude();
        passband_peak = passband_peak.max(magnitude);
    }
    if passband_peak <= 0.0 {
        return Err("Impulse analysis found zero passband energy.".to_string());
    }

    let raw_stopband_start_hz = stopband_start_hz_override.unwrap_or(effective_nyquist_hz * 1.02);
    let min_stopband_start_hz = (passband_end_hz + bin_hz).min(output_nyquist_hz);
    let stopband_start_hz = raw_stopband_start_hz.max(min_stopband_start_hz);

    let (resolved_stopband_start_hz, stopband_peak_db, stopband_attenuation_db) =
        if stopband_start_hz >= output_nyquist_hz {
            (None, None, None)
        } else {
            let start_bin = ((stopband_start_hz / bin_hz).ceil() as usize).min(half_bins);
            if start_bin >= half_bins {
                (None, None, None)
            } else {
                let mut stopband_peak = 0.0_f64;
                for bin in start_bin..=half_bins {
                    let magnitude = fft_input[bin].magnitude();
                    stopband_peak = stopband_peak.max(magnitude);
                }
                (
                    Some(start_bin as f64 * bin_hz),
                    Some(dbfs_from_amplitude(stopband_peak)),
                    Some(dbfs_from_amplitude(stopband_peak / passband_peak)),
                )
            }
        };

    Ok(ImpulseSpectrumStats {
        fft_size,
        effective_nyquist_hz,
        passband_end_hz,
        passband_peak_db: dbfs_from_amplitude(passband_peak),
        stopband_start_hz: resolved_stopband_start_hz,
        stopband_end_hz: resolved_stopband_start_hz.map(|_| output_nyquist_hz),
        stopband_peak_db,
        stopband_attenuation_db,
    })
}

fn build_self_null_metrics(
    first_case: &RenderedCase,
    second_case: &RenderedCase,
    max_lag_frames: usize,
    lag_window_frames: usize,
) -> Option<SelfNullMetrics> {
    let comparison = compute_residual_metrics(first_case, second_case, max_lag_frames, lag_window_frames)?;
    let bit_exact = comparison.residual_peak_dbfs.is_infinite()
        && comparison.residual_peak_dbfs.is_sign_negative()
        && comparison.residual_rms_dbfs.is_infinite()
        && comparison.residual_rms_dbfs.is_sign_negative();

    Some(SelfNullMetrics {
        filter_token: first_case.filter_token.clone(),
        output_sample_rate_hz: first_case.output_sample_rate_hz,
        lag_frames: comparison.lag_frames,
        overlap_frames: comparison.overlap_frames,
        residual_peak_dbfs: comparison.residual_peak_dbfs,
        residual_rms_dbfs: comparison.residual_rms_dbfs,
        residual_rms_relative_db: comparison.residual_rms_relative_db,
        residual_rms_relative_db_gain_matched: comparison.residual_rms_relative_db_gain_matched,
        gain_matched_snr_db: comparison.gain_matched_snr_db,
        bit_exact,
    })
}

fn build_impulse_analysis_metrics(
    case: &RenderedCase,
    source_sample_rate_hz: u32,
    impulse_input_frames: usize,
    stopband_start_hz_override: Option<f64>,
    impulse_wav_path: Option<String>,
) -> Result<ImpulseAnalysisMetrics, String> {
    let channels = case.channels as usize;
    if channels == 0 {
        return Err("Impulse analysis requires non-zero channel count.".to_string());
    }
    let impulse_output_frames = case.samples.len() / channels;
    let spectrum = analyze_impulse_spectrum(
        &case.samples,
        channels,
        source_sample_rate_hz,
        case.output_sample_rate_hz,
        stopband_start_hz_override,
    )?;

    Ok(ImpulseAnalysisMetrics {
        filter_token: case.filter_token.clone(),
        filter_id: case.filter_id.clone(),
        profile_label: case.profile_label.clone(),
        output_sample_rate_hz: case.output_sample_rate_hz,
        channels: case.channels,
        impulse_input_frames,
        impulse_output_frames,
        fft_size: spectrum.fft_size,
        effective_nyquist_hz: spectrum.effective_nyquist_hz,
        passband_end_hz: spectrum.passband_end_hz,
        passband_peak_db: spectrum.passband_peak_db,
        stopband_start_hz: spectrum.stopband_start_hz,
        stopband_end_hz: spectrum.stopband_end_hz,
        stopband_peak_db: spectrum.stopband_peak_db,
        stopband_attenuation_db: spectrum.stopband_attenuation_db,
        impulse_wav_path,
    })
}

fn write_wav_pcm16(
    path: &Path,
    sample_rate_hz: u32,
    channels: u16,
    samples: &[f32],
) -> Result<(), String> {
    let channels_usize = channels as usize;
    if channels_usize == 0 {
        return Err("WAV writer requires at least 1 channel.".to_string());
    }
    if samples.len() % channels_usize != 0 {
        return Err("Interleaved sample length is not divisible by channel count.".to_string());
    }

    let bytes_per_sample = 2u16;
    let block_align = channels
        .checked_mul(bytes_per_sample)
        .ok_or_else(|| "WAV block align overflow.".to_string())?;
    let byte_rate = sample_rate_hz
        .checked_mul(block_align as u32)
        .ok_or_else(|| "WAV byte rate overflow.".to_string())?;

    let data_bytes = (samples.len() as u64)
        .checked_mul(bytes_per_sample as u64)
        .ok_or_else(|| "WAV data size overflow.".to_string())?;
    if data_bytes > u32::MAX as u64 {
        return Err("WAV data too large for RIFF (4 GiB limit).".to_string());
    }
    let riff_chunk_size = 36u64
        .checked_add(data_bytes)
        .ok_or_else(|| "WAV RIFF chunk size overflow.".to_string())?;
    if riff_chunk_size > u32::MAX as u64 {
        return Err("WAV RIFF chunk too large.".to_string());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create output directory: {error}"))?;
    }

    let file = fs::File::create(path).map_err(|error| format!("Failed to create WAV file: {error}"))?;
    let mut writer = BufWriter::new(file);

    writer
        .write_all(b"RIFF")
        .map_err(|error| format!("Failed to write WAV header: {error}"))?;
    writer
        .write_all(&(riff_chunk_size as u32).to_le_bytes())
        .map_err(|error| format!("Failed to write WAV header: {error}"))?;
    writer
        .write_all(b"WAVE")
        .map_err(|error| format!("Failed to write WAV header: {error}"))?;

    writer
        .write_all(b"fmt ")
        .map_err(|error| format!("Failed to write WAV fmt chunk: {error}"))?;
    writer
        .write_all(&16u32.to_le_bytes())
        .map_err(|error| format!("Failed to write WAV fmt chunk: {error}"))?;
    writer
        .write_all(&1u16.to_le_bytes())
        .map_err(|error| format!("Failed to write WAV fmt chunk: {error}"))?;
    writer
        .write_all(&channels.to_le_bytes())
        .map_err(|error| format!("Failed to write WAV fmt chunk: {error}"))?;
    writer
        .write_all(&sample_rate_hz.to_le_bytes())
        .map_err(|error| format!("Failed to write WAV fmt chunk: {error}"))?;
    writer
        .write_all(&byte_rate.to_le_bytes())
        .map_err(|error| format!("Failed to write WAV fmt chunk: {error}"))?;
    writer
        .write_all(&block_align.to_le_bytes())
        .map_err(|error| format!("Failed to write WAV fmt chunk: {error}"))?;
    writer
        .write_all(&16u16.to_le_bytes())
        .map_err(|error| format!("Failed to write WAV fmt chunk: {error}"))?;

    writer
        .write_all(b"data")
        .map_err(|error| format!("Failed to write WAV data chunk: {error}"))?;
    writer
        .write_all(&(data_bytes as u32).to_le_bytes())
        .map_err(|error| format!("Failed to write WAV data chunk: {error}"))?;

    for sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let pcm = (clamped * i16::MAX as f32) as i16;
        writer
            .write_all(&pcm.to_le_bytes())
            .map_err(|error| format!("Failed to write WAV sample data: {error}"))?;
    }

    writer
        .flush()
        .map_err(|error| format!("Failed to flush WAV file: {error}"))?;

    Ok(())
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
        let bytes = fs::read(path).map_err(|error| format!("Failed to read local file: {error}"))?;
        return Ok(Arc::<[u8]>::from(bytes));
    }

    let bytes = fs::read(src).map_err(|error| format!("Failed to read local source: {error}"))?;
    Ok(Arc::<[u8]>::from(bytes))
}

fn normalize_filter_token(token: &str) -> String {
    token.trim().to_ascii_lowercase()
}

fn filter_token_to_filter_id(token: &str) -> Option<String> {
    let normalized = normalize_filter_token(token);
    if normalized.is_empty() || normalized == "none" || normalized == "off" {
        None
    } else {
        Some(normalized)
    }
}

fn sanitize_case_name(token: &str) -> String {
    token.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

fn parse_parametric_eq_config(path: &Path) -> Result<ParametricEqConfig, String> {
    let payload = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read parametric EQ JSON: {error}"))?;
    let parsed: ParametricEqConfig = serde_json::from_str(&payload)
        .map_err(|error| format!("Invalid parametric EQ JSON format: {error}"))?;
    parsed
        .validate()
        .map_err(|message| format!("Invalid parametric EQ configuration: {message}"))?;
    Ok(parsed)
}

fn detect_best_lag_frames(
    reference_samples: &[f32],
    case_samples: &[f32],
    channels: usize,
    max_lag_frames: usize,
    window_frames: usize,
) -> i32 {
    if channels == 0 {
        return 0;
    }

    let reference_frames = reference_samples.len() / channels;
    let case_frames = case_samples.len() / channels;
    let effective_window = reference_frames.min(case_frames).min(window_frames);
    if effective_window < 32 {
        return 0;
    }

    let mut best_lag = 0i32;
    let mut best_score = f64::NEG_INFINITY;

    for lag in -(max_lag_frames as i32)..=(max_lag_frames as i32) {
        let mut sum_cross = 0.0_f64;
        let mut sum_ref = 0.0_f64;
        let mut sum_case = 0.0_f64;
        let mut used = 0usize;

        for frame in 0..effective_window {
            let case_frame = frame as i64 + lag as i64;
            if case_frame < 0 || case_frame >= case_frames as i64 {
                continue;
            }

            let mut ref_mono = 0.0_f64;
            let mut case_mono = 0.0_f64;
            for channel in 0..channels {
                ref_mono += reference_samples[frame * channels + channel] as f64;
                case_mono += case_samples[case_frame as usize * channels + channel] as f64;
            }
            ref_mono /= channels as f64;
            case_mono /= channels as f64;

            sum_cross += ref_mono * case_mono;
            sum_ref += ref_mono * ref_mono;
            sum_case += case_mono * case_mono;
            used += 1;
        }

        if used < 32 || sum_ref <= 0.0 || sum_case <= 0.0 {
            continue;
        }

        let denom = (sum_ref.sqrt() * sum_case.sqrt()).max(1e-18);
        let score = sum_cross / denom;
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }

    best_lag
}

fn compute_residual_metrics(
    reference_case: &RenderedCase,
    target_case: &RenderedCase,
    max_lag_frames: usize,
    window_frames: usize,
) -> Option<ComparisonMetrics> {
    if reference_case.channels != target_case.channels {
        return None;
    }
    if reference_case.output_sample_rate_hz != target_case.output_sample_rate_hz {
        return None;
    }

    let channels = reference_case.channels as usize;
    if channels == 0 {
        return None;
    }

    let lag = detect_best_lag_frames(
        &reference_case.samples,
        &target_case.samples,
        channels,
        max_lag_frames,
        window_frames,
    );

    let reference_frames = reference_case.samples.len() / channels;
    let target_frames = target_case.samples.len() / channels;

    let (start_reference, start_target) = if lag >= 0 {
        (0usize, lag as usize)
    } else {
        ((-lag) as usize, 0usize)
    };

    if start_reference >= reference_frames || start_target >= target_frames {
        return None;
    }

    let overlap_frames = (reference_frames - start_reference).min(target_frames - start_target);
    if overlap_frames == 0 {
        return None;
    }

    let mut residual_peak = 0.0_f64;
    let mut residual_sum_sq = 0.0_f64;
    let mut residual_sample_count = 0usize;
    let mut reference_sum_sq = 0.0_f64;
    let mut target_sum_sq = 0.0_f64;
    let mut cross_sum = 0.0_f64;

    for frame in 0..overlap_frames {
        let reference_base = (start_reference + frame) * channels;
        let target_base = (start_target + frame) * channels;
        for channel in 0..channels {
            let reference_value = reference_case.samples[reference_base + channel] as f64;
            let target_value = target_case.samples[target_base + channel] as f64;
            let residual = target_value - reference_value;
            residual_peak = residual_peak.max(residual.abs());
            residual_sum_sq += residual * residual;
            reference_sum_sq += reference_value * reference_value;
            target_sum_sq += target_value * target_value;
            cross_sum += reference_value * target_value;
            residual_sample_count += 1;
        }
    }

    if residual_sample_count == 0 {
        return None;
    }

    let residual_rms = (residual_sum_sq / residual_sample_count as f64).sqrt();
    let reference_rms = (reference_sum_sq / residual_sample_count as f64).sqrt();
    let target_rms = (target_sum_sq / residual_sample_count as f64).sqrt();

    let residual_rms_relative_db = if reference_rms <= 0.0 {
        f64::NEG_INFINITY
    } else {
        dbfs_from_amplitude(residual_rms / reference_rms)
    };

    let correlation = if reference_sum_sq <= 0.0 || target_sum_sq <= 0.0 {
        0.0
    } else {
        let denom = (reference_sum_sq * target_sum_sq).sqrt().max(1e-18);
        (cross_sum / denom).clamp(-1.0, 1.0)
    };

    let level_delta_db = if reference_rms <= 0.0 {
        f64::NEG_INFINITY
    } else {
        dbfs_from_amplitude(target_rms / reference_rms)
    };

    let gain_matched_scale = if reference_sum_sq <= 0.0 {
        1.0
    } else {
        cross_sum / reference_sum_sq
    };
    let gain_matched_phase_inverted = gain_matched_scale.is_sign_negative();
    let gain_matched_scale_db = dbfs_from_amplitude(gain_matched_scale.abs());
    let residual_sum_sq_gain_matched =
        (target_sum_sq - 2.0 * gain_matched_scale * cross_sum
            + gain_matched_scale * gain_matched_scale * reference_sum_sq)
            .max(0.0);
    let residual_rms_gain_matched =
        (residual_sum_sq_gain_matched / residual_sample_count as f64).sqrt();
    let residual_rms_dbfs_gain_matched = dbfs_from_amplitude(residual_rms_gain_matched);
    let residual_rms_relative_db_gain_matched = if reference_rms <= 0.0 {
        f64::NEG_INFINITY
    } else {
        dbfs_from_amplitude(residual_rms_gain_matched / reference_rms)
    };
    let gain_matched_snr_db = if residual_rms_gain_matched <= 0.0 {
        f64::INFINITY
    } else {
        dbfs_from_amplitude(reference_rms / residual_rms_gain_matched)
    };

    Some(ComparisonMetrics {
        filter_token: target_case.filter_token.clone(),
        reference_filter_token: reference_case.filter_token.clone(),
        lag_frames: lag,
        overlap_frames,
        residual_peak_dbfs: dbfs_from_amplitude(residual_peak),
        residual_rms_dbfs: dbfs_from_amplitude(residual_rms),
        residual_rms_relative_db,
        correlation,
        level_delta_db,
        gain_matched_scale,
        gain_matched_scale_db,
        gain_matched_phase_inverted,
        residual_rms_dbfs_gain_matched,
        residual_rms_relative_db_gain_matched,
        gain_matched_snr_db,
    })
}

fn run_case(
    decoded: &DecodedPcmData,
    filter_token: &str,
    target_sample_rate_hz: u32,
    output_dir: Option<&Path>,
    write_wav: bool,
    volume: f32,
    parametric_eq: Option<&ParametricEqConfig>,
    notes: &mut Vec<String>,
) -> Result<RenderedCase, String> {
    let started_at = Instant::now();
    let channels = decoded.source_info.channels as usize;
    if channels == 0 {
        return Err("Source channel count is invalid.".to_string());
    }

    let filter_id = filter_token_to_filter_id(filter_token);
    let source_sample_rate_hz = decoded.source_info.sample_rate_hz;
    let resolved_target_sample_rate_hz =
        normalize_target_sample_rate_for_source(source_sample_rate_hz, target_sample_rate_hz);
    let needs_resampling =
        filter_id.is_some() && resolved_target_sample_rate_hz != source_sample_rate_hz;
    let case_sample_rate_hz = if needs_resampling {
        resolved_target_sample_rate_hz
    } else {
        source_sample_rate_hz
    };

    let mut processed_samples = if needs_resampling {
        let (profile, matched) = HqResamplerProfile::from_filter_id(filter_id.as_deref());
        if !matched {
            notes.push(format!(
                "Filter '{}' is not mapped yet in native HQ profile table; fallback profile '{}' is used.",
                filter_id.as_deref().unwrap_or("none"),
                profile.as_label()
            ));
        }
        resample_interleaved(
            &decoded.samples,
            channels,
            source_sample_rate_hz,
            resolved_target_sample_rate_hz,
            profile,
        )?
    } else {
        decoded.samples.to_vec()
    };

    if let Some(config) = parametric_eq {
        if let Some(mut processor) = ParametricEqProcessor::new(config, channels, case_sample_rate_hz) {
            processor.process_interleaved_in_place(&mut processed_samples);
        }
    }

    let pre_gain = if needs_resampling {
        HQ_RESAMPLER_OUTPUT_HEADROOM_GAIN
    } else {
        1.0_f32
    };
    let total_gain = pre_gain * volume;
    for sample in &mut processed_samples {
        *sample *= total_gain;
    }

    let processing_time_ms = started_at.elapsed().as_secs_f64() * 1000.0;
    let profile_label = filter_id.as_deref().map(|filter_id| {
        let (profile, _) = HqResamplerProfile::from_filter_id(Some(filter_id));
        profile.as_label().to_string()
    });

    let mut wav_path = None;
    if write_wav {
        let output_dir = output_dir.ok_or_else(|| {
            "Output directory is required when --write-wav is enabled.".to_string()
        })?;
        let file_name = format!("{}.wav", sanitize_case_name(filter_token));
        let path = output_dir.join(file_name);
        write_wav_pcm16(
            &path,
            case_sample_rate_hz,
            decoded.source_info.channels,
            &processed_samples,
        )?;
        wav_path = Some(path.to_string_lossy().to_string());
    }

    Ok(RenderedCase {
        filter_token: filter_token.to_string(),
        filter_id,
        profile_label,
        output_sample_rate_hz: case_sample_rate_hz,
        channels: decoded.source_info.channels,
        samples: processed_samples,
        processing_time_ms,
        wav_path,
    })
}

fn build_case_metrics(case: &RenderedCase) -> CaseMetrics {
    let channels = case.channels as usize;
    let frames = if channels == 0 {
        0
    } else {
        case.samples.len() / channels
    };
    let duration_seconds = if case.output_sample_rate_hz == 0 {
        0.0
    } else {
        frames as f64 / case.output_sample_rate_hz as f64
    };

    let peak = compute_peak(&case.samples);
    let true_peak = compute_true_peak_linear_4x(&case.samples, channels);
    let rms = compute_rms(&case.samples);
    let clip_samples = compute_clip_count(&case.samples);
    let clip_ratio = if case.samples.is_empty() {
        0.0
    } else {
        clip_samples as f64 / case.samples.len() as f64
    };
    let peak_dbfs = dbfs_from_amplitude(peak);
    let rms_dbfs = dbfs_from_amplitude(rms);

    CaseMetrics {
        filter_token: case.filter_token.clone(),
        filter_id: case.filter_id.clone(),
        profile_label: case.profile_label.clone(),
        output_sample_rate_hz: case.output_sample_rate_hz,
        channels: case.channels,
        frames,
        duration_seconds,
        processing_time_ms: case.processing_time_ms,
        peak_dbfs,
        true_peak_dbfs: dbfs_from_amplitude(true_peak),
        rms_dbfs,
        crest_factor_db: peak_dbfs - rms_dbfs,
        clip_samples,
        clip_ratio,
        wav_path: case.wav_path.clone(),
    }
}

fn print_usage() {
    eprintln!(
        "\
offline-oversampling-lab

Usage:
  cargo run --release --bin offline-oversampling-lab -- \\
    --src <audio-file-or-url> \\
    [--filters <csv>] \\
    [--target-sample-rate <hz>] \\
    [--output-dir <path>] \\
    [--write-wav] \\
    [--volume <linear>] \\
    [--reference-filter <token>] \\
    [--max-lag-frames <n>] \\
    [--lag-window-frames <n>] \\
    [--parametric-eq-json <path>] \\
    [--self-null] \\
    [--analyze-impulse] \\
    [--impulse-frames <n>] \\
    [--write-impulse-wav] \\
    [--stopband-start-hz <hz>]

Examples:
  cargo run --release --bin offline-oversampling-lab -- \\
    --src ./sample.flac \\
    --filters none,poly-sinc-short-mp,poly-sinc-mp,poly-sinc-lp,poly-sinc-long-lp \\
    --target-sample-rate 192000 \\
    --output-dir ./offline-lab \\
    --write-wav \\
    --self-null \\
    --analyze-impulse \\
    --write-impulse-wav
"
    );
}

fn parse_next_value(args: &[String], index: &mut usize, flag: &str) -> Result<String, String> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| format!("Missing value for {flag}"))
}

fn parse_args() -> Result<CliArgs, String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_usage();
        std::process::exit(0);
    }

    let mut src: Option<String> = None;
    let mut filters: Option<Vec<String>> = None;
    let mut target_sample_rate_hz: Option<u32> = None;
    let mut output_dir: Option<PathBuf> = None;
    let mut write_wav = false;
    let mut volume = 1.0_f32;
    let mut reference_filter: Option<String> = None;
    let mut max_lag_frames = DEFAULT_MAX_LAG_FRAMES;
    let mut lag_window_frames = DEFAULT_LAG_WINDOW_FRAMES;
    let mut parametric_eq_json: Option<PathBuf> = None;
    let mut self_null = false;
    let mut analyze_impulse = false;
    let mut impulse_frames = DEFAULT_IMPULSE_FRAMES;
    let mut write_impulse_wav = false;
    let mut stopband_start_hz: Option<f64> = None;

    let mut index = 0usize;
    while index < args.len() {
        match args[index].as_str() {
            "--src" => {
                src = Some(parse_next_value(&args, &mut index, "--src")?);
            }
            "--filters" => {
                let raw = parse_next_value(&args, &mut index, "--filters")?;
                let parsed = raw
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.to_string())
                    .collect::<Vec<_>>();
                filters = Some(parsed);
            }
            "--target-sample-rate" => {
                let raw = parse_next_value(&args, &mut index, "--target-sample-rate")?;
                let parsed = raw
                    .parse::<u32>()
                    .map_err(|error| format!("Invalid --target-sample-rate value '{raw}': {error}"))?;
                if parsed < 8_000 {
                    return Err("--target-sample-rate must be >= 8000.".to_string());
                }
                target_sample_rate_hz = Some(parsed);
            }
            "--output-dir" => {
                output_dir = Some(PathBuf::from(parse_next_value(&args, &mut index, "--output-dir")?));
            }
            "--write-wav" => {
                write_wav = true;
            }
            "--volume" => {
                let raw = parse_next_value(&args, &mut index, "--volume")?;
                let parsed = raw
                    .parse::<f32>()
                    .map_err(|error| format!("Invalid --volume value '{raw}': {error}"))?;
                if !parsed.is_finite() || parsed < 0.0 {
                    return Err("--volume must be a finite number >= 0.".to_string());
                }
                volume = parsed;
            }
            "--reference-filter" => {
                reference_filter = Some(parse_next_value(&args, &mut index, "--reference-filter")?);
            }
            "--max-lag-frames" => {
                let raw = parse_next_value(&args, &mut index, "--max-lag-frames")?;
                max_lag_frames = raw
                    .parse::<usize>()
                    .map_err(|error| format!("Invalid --max-lag-frames value '{raw}': {error}"))?;
            }
            "--lag-window-frames" => {
                let raw = parse_next_value(&args, &mut index, "--lag-window-frames")?;
                lag_window_frames = raw.parse::<usize>().map_err(|error| {
                    format!("Invalid --lag-window-frames value '{raw}': {error}")
                })?;
            }
            "--parametric-eq-json" => {
                parametric_eq_json = Some(PathBuf::from(parse_next_value(
                    &args,
                    &mut index,
                    "--parametric-eq-json",
                )?));
            }
            "--self-null" => {
                self_null = true;
            }
            "--analyze-impulse" => {
                analyze_impulse = true;
            }
            "--impulse-frames" => {
                let raw = parse_next_value(&args, &mut index, "--impulse-frames")?;
                impulse_frames = raw
                    .parse::<usize>()
                    .map_err(|error| format!("Invalid --impulse-frames value '{raw}': {error}"))?;
                if impulse_frames < 64 {
                    return Err("--impulse-frames must be >= 64.".to_string());
                }
            }
            "--write-impulse-wav" => {
                write_impulse_wav = true;
            }
            "--stopband-start-hz" => {
                let raw = parse_next_value(&args, &mut index, "--stopband-start-hz")?;
                let parsed = raw
                    .parse::<f64>()
                    .map_err(|error| format!("Invalid --stopband-start-hz value '{raw}': {error}"))?;
                if !parsed.is_finite() || parsed <= 0.0 {
                    return Err("--stopband-start-hz must be a finite number > 0.".to_string());
                }
                stopband_start_hz = Some(parsed);
            }
            unknown => {
                return Err(format!("Unknown argument: {unknown}. Use --help to see usage."));
            }
        }
        index += 1;
    }

    let src = src.ok_or_else(|| "Missing required argument --src.".to_string())?;
    let filters = filters.unwrap_or_else(|| {
        vec![
            "none".to_string(),
            "poly-sinc-short-mp".to_string(),
            "poly-sinc-mp".to_string(),
            "poly-sinc-lp".to_string(),
            "poly-sinc-long-lp".to_string(),
            "poly-sinc-long-ip".to_string(),
            "poly-sinc-gauss".to_string(),
            "poly-sinc-ext2".to_string(),
        ]
    });
    if filters.is_empty() {
        return Err("At least one filter is required.".to_string());
    }

    if write_wav && output_dir.is_none() {
        return Err("--output-dir is required when --write-wav is enabled.".to_string());
    }
    if write_impulse_wav && !analyze_impulse {
        return Err("--write-impulse-wav requires --analyze-impulse.".to_string());
    }
    if write_impulse_wav && output_dir.is_none() {
        return Err("--output-dir is required when --write-impulse-wav is enabled.".to_string());
    }

    Ok(CliArgs {
        src,
        filters,
        target_sample_rate_hz,
        output_dir,
        write_wav,
        volume,
        reference_filter,
        max_lag_frames,
        lag_window_frames,
        parametric_eq_json,
        self_null,
        analyze_impulse,
        impulse_frames,
        write_impulse_wav,
        stopband_start_hz,
    })
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = parse_args()?;

    if let Some(output_dir) = args.output_dir.as_ref() {
        fs::create_dir_all(output_dir)
            .map_err(|error| format!("Failed to create output directory: {error}"))?;
    }

    let parametric_eq = match args.parametric_eq_json.as_ref() {
        Some(path) => Some(parse_parametric_eq_config(path)?),
        None => None,
    };

    let audio_data = fetch_audio_data(&args.src)?;
    let decoder_backend = decoder::default_decoder_backend();
    let decoded = decoder_backend
        .decode_pcm(audio_data)
        .map_err(|error| format!("Decode failed: {error}"))?;

    let source_sample_rate_hz = decoded.source_info.sample_rate_hz;
    let requested_target_sample_rate_hz = args
        .target_sample_rate_hz
        .unwrap_or(source_sample_rate_hz);
    let target_sample_rate_hz = normalize_target_sample_rate_for_source(
        source_sample_rate_hz,
        requested_target_sample_rate_hz,
    );
    let mut notes = Vec::<String>::new();
    if args.target_sample_rate_hz.is_none() {
        notes.push(
            "No --target-sample-rate was provided; source sample rate is used as target."
                .to_string(),
        );
    }
    if target_sample_rate_hz != requested_target_sample_rate_hz {
        notes.push(format!(
            "Target sample rate was normalized from {} Hz to {} Hz to match source family ({} Hz).",
            requested_target_sample_rate_hz, target_sample_rate_hz, source_sample_rate_hz
        ));
    }
    notes.push(format!(
        "Decoder backend: {}",
        decoder_backend.name()
    ));

    let requested_reference_filter = args
        .reference_filter
        .clone()
        .unwrap_or_else(|| args.filters[0].clone());
    let resolved_reference_filter = if args
        .filters
        .iter()
        .any(|filter| filter == &requested_reference_filter)
    {
        requested_reference_filter
    } else {
        let fallback = args.filters[0].clone();
        notes.push(format!(
            "Reference filter '{}' was not found; fallback to '{}'.",
            requested_reference_filter, fallback
        ));
        fallback
    };

    let reference_case = run_case(
        &decoded,
        &resolved_reference_filter,
        target_sample_rate_hz,
        args.output_dir.as_deref(),
        args.write_wav,
        args.volume,
        parametric_eq.as_ref(),
        &mut notes,
    )?;
    let reference_metrics = build_case_metrics(&reference_case);

    let mut case_metrics = Vec::<CaseMetrics>::new();
    let mut comparisons = Vec::<ComparisonMetrics>::new();
    let mut self_nulls = Vec::<SelfNullMetrics>::new();

    if args.self_null {
        let mut scratch_notes = Vec::<String>::new();
        let rerendered_reference_case = run_case(
            &decoded,
            &resolved_reference_filter,
            target_sample_rate_hz,
            None,
            false,
            args.volume,
            parametric_eq.as_ref(),
            &mut scratch_notes,
        )?;
        if let Some(metrics) = build_self_null_metrics(
            &reference_case,
            &rerendered_reference_case,
            args.max_lag_frames,
            args.lag_window_frames,
        ) {
            self_nulls.push(metrics);
        } else {
            notes.push(format!(
                "Self-null skipped for '{}' (sample-rate or channel mismatch).",
                resolved_reference_filter
            ));
        }
    }

    for filter in &args.filters {
        if filter == &resolved_reference_filter {
            case_metrics.push(reference_metrics.clone());
            continue;
        }

        let case = run_case(
            &decoded,
            filter,
            target_sample_rate_hz,
            args.output_dir.as_deref(),
            args.write_wav,
            args.volume,
            parametric_eq.as_ref(),
            &mut notes,
        )?;
        let metrics = build_case_metrics(&case);
        case_metrics.push(metrics);

        if let Some(comparison) = compute_residual_metrics(
            &reference_case,
            &case,
            args.max_lag_frames,
            args.lag_window_frames,
        ) {
            comparisons.push(comparison);
        } else {
            notes.push(format!(
                "Comparison skipped: '{}' vs '{}' (sample-rate or channel mismatch).",
                case.filter_token, reference_case.filter_token
            ));
        }

        if args.self_null {
            let mut scratch_notes = Vec::<String>::new();
            let rerendered_case = run_case(
                &decoded,
                filter,
                target_sample_rate_hz,
                None,
                false,
                args.volume,
                parametric_eq.as_ref(),
                &mut scratch_notes,
            )?;
            if let Some(metrics) = build_self_null_metrics(
                &case,
                &rerendered_case,
                args.max_lag_frames,
                args.lag_window_frames,
            ) {
                self_nulls.push(metrics);
            } else {
                notes.push(format!(
                    "Self-null skipped for '{}' (sample-rate or channel mismatch).",
                    filter
                ));
            }
        }
    }

    let mut impulse_analyses = Vec::<ImpulseAnalysisMetrics>::new();
    if args.analyze_impulse {
        if parametric_eq.is_some() {
            notes.push(
                "Impulse analysis bypasses parametric EQ to isolate resampler behavior."
                    .to_string(),
            );
        }
        if (args.volume - 1.0_f32).abs() > f32::EPSILON {
            notes.push("Impulse analysis bypasses --volume and uses unity gain.".to_string());
        }

        let impulse_source = build_synthetic_impulse_source(
            source_sample_rate_hz,
            decoded.source_info.channels,
            args.impulse_frames,
        )?;
        let mut analyzed_filters = BTreeSet::<String>::new();

        for filter in &args.filters {
            if !analyzed_filters.insert(filter.clone()) {
                continue;
            }

            let mut scratch_notes = Vec::<String>::new();
            let impulse_case = run_case(
                &impulse_source,
                filter,
                target_sample_rate_hz,
                None,
                false,
                1.0_f32,
                None,
                &mut scratch_notes,
            )?;

            for note in scratch_notes {
                notes.push(format!("[impulse:{}] {}", filter, note));
            }

            let impulse_wav_path = if args.write_impulse_wav {
                let output_dir = args.output_dir.as_ref().ok_or_else(|| {
                    "--output-dir is required when --write-impulse-wav is enabled.".to_string()
                })?;
                let file_name = format!("impulse-{}.wav", sanitize_case_name(filter));
                let path = output_dir.join(file_name);
                write_wav_pcm16(
                    &path,
                    impulse_case.output_sample_rate_hz,
                    impulse_case.channels,
                    &impulse_case.samples,
                )?;
                Some(path.to_string_lossy().to_string())
            } else {
                None
            };

            let impulse_metrics = build_impulse_analysis_metrics(
                &impulse_case,
                source_sample_rate_hz,
                args.impulse_frames,
                args.stopband_start_hz,
                impulse_wav_path,
            )?;

            if impulse_metrics.stopband_attenuation_db.is_none() {
                notes.push(format!(
                    "Impulse stopband attenuation unavailable for '{}' because no stopband region was found above effective Nyquist.",
                    filter
                ));
            }

            impulse_analyses.push(impulse_metrics);
        }
    }

    let report = OfflineLabReport {
        source: args.src,
        source_sample_rate_hz: decoded.source_info.sample_rate_hz,
        source_channels: decoded.source_info.channels,
        source_duration_seconds: decoded.source_info.duration_seconds,
        target_sample_rate_hz,
        write_wav: args.write_wav,
        output_dir: args
            .output_dir
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        notes,
        cases: case_metrics,
        comparisons,
        self_nulls,
        impulse_analyses,
    };

    if let Some(output_dir) = args.output_dir {
        let report_path = output_dir.join("report.json");
        let report_json = serde_json::to_string_pretty(&report)
            .map_err(|error| format!("Failed to serialize report: {error}"))?;
        fs::write(&report_path, report_json)
            .map_err(|error| format!("Failed to write report JSON: {error}"))?;
    }

    let stdout = serde_json::to_string_pretty(&report)
        .map_err(|error| format!("Failed to serialize report: {error}"))?;
    println!("{stdout}");
    Ok(())
}
