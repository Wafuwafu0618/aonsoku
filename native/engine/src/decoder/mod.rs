use std::io::{ErrorKind, Read, Seek};
use std::sync::Arc;

use symphonia::core::audio::{AudioBufferRef, SampleBuffer};
use symphonia::core::codecs::{CodecParameters, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_codecs, get_probe};

const DEFAULT_TRACK_DURATION_SECONDS: f64 = 300.0;

#[derive(Debug, Clone)]
pub struct DecodedSourceInfo {
    pub channels: u16,
    pub sample_rate_hz: u32,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone)]
pub struct DecodedPcmData {
    pub source_info: DecodedSourceInfo,
    pub samples: Arc<[f32]>,
    pub conversion_path: &'static str,
}

pub trait DecoderBackend: Send + Sync {
    fn name(&self) -> &'static str;
    fn inspect(&self, data: Arc<[u8]>) -> Result<DecodedSourceInfo, String>;
    fn decode_pcm(&self, data: Arc<[u8]>) -> Result<DecodedPcmData, String>;
}

#[derive(Default)]
pub struct SymphoniaDecoderBackend;

struct SymphoniaDecodedPcm {
    source_info: DecodedSourceInfo,
    samples: Vec<f32>,
}

#[derive(Debug, Clone, Copy)]
struct SymphoniaDecodeConfig {
    start_at_seconds: f64,
    collect_pcm: bool,
}

fn sanitize_duration_seconds(duration: Option<f64>) -> f64 {
    let duration_seconds = duration.unwrap_or(DEFAULT_TRACK_DURATION_SECONDS);

    if !duration_seconds.is_finite() || duration_seconds < 0.0 {
        DEFAULT_TRACK_DURATION_SECONDS
    } else {
        duration_seconds
    }
}

fn duration_from_codec_params(codec_params: &CodecParameters) -> Option<f64> {
    let (time_base, n_frames) = (codec_params.time_base?, codec_params.n_frames?);
    let time = time_base.calc_time(n_frames);
    Some(time.seconds as f64 + time.frac)
}

fn append_audio_buffer_to_f32_vec(
    buffer: AudioBufferRef<'_>,
    output: &mut Vec<f32>,
    remaining_skip_samples: &mut usize,
) {
    let mut sample_buffer = SampleBuffer::<f32>::new(buffer.capacity() as u64, *buffer.spec());
    sample_buffer.copy_interleaved_ref(buffer);

    let interleaved = sample_buffer.samples();
    if interleaved.is_empty() {
        return;
    }

    if *remaining_skip_samples > 0 {
        let skip = (*remaining_skip_samples).min(interleaved.len());
        *remaining_skip_samples -= skip;
        if skip >= interleaved.len() {
            return;
        }
        output.extend_from_slice(&interleaved[skip..]);
        return;
    }

    output.extend_from_slice(interleaved);
}

fn decode_with_symphonia<M>(
    data: M,
    config: SymphoniaDecodeConfig,
) -> Result<SymphoniaDecodedPcm, String>
where
    M: MediaSource + Read + Seek + Send + Sync + 'static,
{
    let source_stream = MediaSourceStream::new(Box::new(data), Default::default());

    let hint = Hint::new();
    let probed = get_probe()
        .format(
            &hint,
            source_stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| format!("Failed to probe audio format with symphonia: {error}"))?;

    let mut format = probed.format;
    let default_track = format
        .default_track()
        .ok_or_else(|| "Failed to locate default audio track with symphonia.".to_string())?;

    if default_track.codec_params.codec == CODEC_TYPE_NULL {
        return Err("Default track codec is not supported by symphonia.".to_string());
    }

    let track_id = default_track.id;
    let mut decoder = get_codecs()
        .make(&default_track.codec_params, &DecoderOptions::default())
        .map_err(|error| format!("Failed to create symphonia decoder: {error}"))?;

    let mut channels = default_track
        .codec_params
        .channels
        .map(|value| value.count() as u16)
        .unwrap_or(0);
    let mut sample_rate_hz = default_track.codec_params.sample_rate.unwrap_or(0);
    let mut duration_seconds = duration_from_codec_params(&default_track.codec_params);

    let mut samples = Vec::<f32>::new();
    let mut decoded_frames_total = 0usize;
    let mut remaining_skip_samples = 0usize;
    let mut skip_budget_initialized = false;
    let start_at_seconds = if config.start_at_seconds.is_finite() {
        config.start_at_seconds.max(0.0)
    } else {
        0.0
    };

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                break;
            }
            Err(SymphoniaError::ResetRequired) => {
                return Err("Symphonia decoder reset is required but not yet supported.".to_string());
            }
            Err(error) => {
                return Err(format!("Failed to read next packet with symphonia: {error}"));
            }
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::ResetRequired) => {
                return Err("Symphonia decoder reset is required but not yet supported.".to_string());
            }
            Err(error) => {
                return Err(format!("Failed to decode packet with symphonia: {error}"));
            }
        };

        if channels == 0 {
            channels = decoded.spec().channels.count() as u16;
        }
        if sample_rate_hz == 0 {
            sample_rate_hz = decoded.spec().rate;
        }

        if channels > 0 && sample_rate_hz > 0 {
            let frame_samples = decoded.frames() as usize * channels as usize;
            decoded_frames_total = decoded_frames_total.saturating_add(decoded.frames() as usize);

            if !skip_budget_initialized && start_at_seconds > 0.0 {
                let seek_start_frames = (start_at_seconds * sample_rate_hz as f64)
                    .floor()
                    .max(0.0) as usize;
                remaining_skip_samples = seek_start_frames.saturating_mul(channels as usize);
                skip_budget_initialized = true;
            }

            if config.collect_pcm {
                append_audio_buffer_to_f32_vec(decoded, &mut samples, &mut remaining_skip_samples);
            } else if frame_samples > 0 {
                // Inspect path only needs metadata; avoid full decode cost.
                break;
            }
        }
    }

    if channels == 0 || sample_rate_hz == 0 {
        return Err("Decoded source produced invalid channel/sample-rate metadata.".to_string());
    }

    if duration_seconds.is_none() && config.collect_pcm {
        duration_seconds = Some(decoded_frames_total as f64 / sample_rate_hz as f64);
    }

    Ok(SymphoniaDecodedPcm {
        source_info: DecodedSourceInfo {
            channels,
            sample_rate_hz,
            duration_seconds: sanitize_duration_seconds(duration_seconds),
        },
        samples,
    })
}

impl DecoderBackend for SymphoniaDecoderBackend {
    fn name(&self) -> &'static str {
        "symphonia"
    }

    fn inspect(&self, data: Arc<[u8]>) -> Result<DecodedSourceInfo, String> {
        decode_with_symphonia(
            std::io::Cursor::new(data),
            SymphoniaDecodeConfig {
                start_at_seconds: 0.0,
                collect_pcm: false,
            },
        )
        .map(|decoded| decoded.source_info)
    }

    fn decode_pcm(&self, data: Arc<[u8]>) -> Result<DecodedPcmData, String> {
        let decoded = decode_with_symphonia(
            std::io::Cursor::new(data),
            SymphoniaDecodeConfig {
                start_at_seconds: 0.0,
                collect_pcm: true,
            },
        )?;

        Ok(DecodedPcmData {
            source_info: decoded.source_info,
            samples: Arc::<[f32]>::from(decoded.samples),
            conversion_path: "symphonia:decode-f32",
        })
    }
}

pub fn default_decoder_backend() -> Arc<dyn DecoderBackend> {
    let backend_name = std::env::var("AONSOKU_NATIVE_DECODER")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "symphonia".to_string());

    if backend_name != "symphonia" {
        eprintln!(
            "[NativeAudioSidecar][M5] unsupported decoder backend '{}', fallback to symphonia",
            backend_name
        );
    }

    Arc::new(SymphoniaDecoderBackend)
}
