use std::io::{BufReader, Cursor, ErrorKind};
use std::sync::Arc;
use std::time::Duration;

use rodio::buffer::SamplesBuffer;
use rodio::Sink;
use rodio::{Decoder as RodioDecoder, Sample, Source};
use symphonia::core::audio::{AudioBufferRef, SampleBuffer, Signal};
use symphonia::core::codecs::{CodecParameters, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
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

#[derive(Debug, Clone, Copy)]
pub struct DecodePlaybackOptions {
    pub start_at_seconds: f64,
    pub playback_rate: f64,
    pub loop_enabled: bool,
}

impl Default for DecodePlaybackOptions {
    fn default() -> Self {
        Self {
            start_at_seconds: 0.0,
            playback_rate: 1.0,
            loop_enabled: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DecodedStreamDescriptor {
    pub source_info: DecodedSourceInfo,
    pub conversion_path: &'static str,
}

pub trait DecodedStream {
    fn descriptor(&self) -> &DecodedStreamDescriptor;
    fn append_to_sink(self: Box<Self>, sink: &Sink) -> Result<(), String>;
}

pub trait DecoderBackend: Send + Sync {
    fn name(&self) -> &'static str;
    fn inspect(&self, data: Arc<[u8]>) -> Result<DecodedSourceInfo, String>;
    fn decode_pcm(&self, data: Arc<[u8]>) -> Result<DecodedPcmData, String>;
    fn decode_stream(
        &self,
        data: Arc<[u8]>,
        options: DecodePlaybackOptions,
    ) -> Result<Box<dyn DecodedStream>, String>;
}

#[derive(Default)]
pub struct RodioDecoderBackend;

#[derive(Default)]
pub struct SymphoniaDecoderBackend;

type RodioPlaybackSource = rodio::source::Speed<
    rodio::source::SkipDuration<RodioDecoder<BufReader<Cursor<Arc<[u8]>>>>>,
>;

struct RodioDecodedStream {
    descriptor: DecodedStreamDescriptor,
    source: Option<RodioPlaybackSource>,
    loop_enabled: bool,
}

impl DecodedStream for RodioDecodedStream {
    fn descriptor(&self) -> &DecodedStreamDescriptor {
        &self.descriptor
    }

    fn append_to_sink(mut self: Box<Self>, sink: &Sink) -> Result<(), String> {
        let source = self
            .source
            .take()
            .ok_or_else(|| "Decoded stream has already been consumed.".to_string())?;

        if self.loop_enabled {
            sink.append(source.repeat_infinite());
        } else {
            sink.append(source);
        }

        Ok(())
    }
}

struct SymphoniaDecodedStream {
    descriptor: DecodedStreamDescriptor,
    samples: Option<Vec<f32>>,
    channels: u16,
    sample_rate_hz: u32,
    playback_rate: f64,
    loop_enabled: bool,
}

impl DecodedStream for SymphoniaDecodedStream {
    fn descriptor(&self) -> &DecodedStreamDescriptor {
        &self.descriptor
    }

    fn append_to_sink(mut self: Box<Self>, sink: &Sink) -> Result<(), String> {
        let samples = self
            .samples
            .take()
            .ok_or_else(|| "Decoded stream has already been consumed.".to_string())?;

        let base_source = SamplesBuffer::new(self.channels, self.sample_rate_hz, samples);
        let playback_rate = if self.playback_rate.is_finite() {
            self.playback_rate.max(0.01)
        } else {
            1.0
        };

        if self.loop_enabled {
            sink.append(base_source.repeat_infinite().speed(playback_rate as f32));
        } else {
            sink.append(base_source.speed(playback_rate as f32));
        }

        Ok(())
    }
}

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

fn inspect_source_metadata<S>(source: &S) -> Result<DecodedSourceInfo, String>
where
    S: Source,
    S::Item: Sample,
{
    let channels = source.channels();
    let sample_rate_hz = source.sample_rate();
    if channels == 0 || sample_rate_hz == 0 {
        return Err(
            "Decoded source produced invalid channel/sample-rate metadata.".to_string(),
        );
    }

    Ok(DecodedSourceInfo {
        channels,
        sample_rate_hz,
        duration_seconds: sanitize_duration_seconds(
            source.total_duration().map(|value| value.as_secs_f64()),
        ),
    })
}

fn build_rodio_playback_source(
    data: Arc<[u8]>,
    options: DecodePlaybackOptions,
) -> Result<RodioPlaybackSource, String> {
    let decoder = RodioDecoder::new(BufReader::new(Cursor::new(data)))
        .map_err(|error| format!("Failed to decode audio data: {error}"))?;

    let start_at_seconds = if options.start_at_seconds.is_finite() {
        options.start_at_seconds.max(0.0)
    } else {
        0.0
    };

    let playback_rate = if options.playback_rate.is_finite() {
        options.playback_rate.max(0.01)
    } else {
        1.0
    };

    Ok(decoder
        .skip_duration(Duration::from_secs_f64(start_at_seconds))
        .speed(playback_rate as f32))
}

fn decode_with_rodio_pcm(data: Arc<[u8]>) -> Result<DecodedPcmData, String> {
    let decoder = RodioDecoder::new(BufReader::new(Cursor::new(data)))
        .map_err(|error| format!("Failed to decode audio data: {error}"))?;

    let mut source_info = inspect_source_metadata(&decoder)?;
    let samples: Vec<f32> = decoder.map(|sample| sample.to_f32()).collect();
    let total_frames = if source_info.channels == 0 {
        0
    } else {
        samples.len() / source_info.channels as usize
    };
    if source_info.sample_rate_hz > 0 {
        source_info.duration_seconds = sanitize_duration_seconds(Some(
            total_frames as f64 / source_info.sample_rate_hz as f64,
        ));
    }

    Ok(DecodedPcmData {
        source_info,
        samples: Arc::<[f32]>::from(samples),
        conversion_path: "rodio:decode-f32",
    })
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

fn decode_with_symphonia(
    data: Arc<[u8]>,
    config: SymphoniaDecodeConfig,
) -> Result<SymphoniaDecodedPcm, String> {
    let media_source = Cursor::new(data);
    let source_stream = MediaSourceStream::new(Box::new(media_source), Default::default());

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
                return Err(
                    "Symphonia decoder reset is required but not yet supported.".to_string(),
                );
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
                return Err(
                    "Symphonia decoder reset is required but not yet supported.".to_string(),
                );
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
            decoded_frames_total =
                decoded_frames_total.saturating_add(decoded.frames() as usize);

            if !skip_budget_initialized && start_at_seconds > 0.0 {
                let seek_start_frames =
                    (start_at_seconds * sample_rate_hz as f64).floor().max(0.0) as usize;
                remaining_skip_samples =
                    seek_start_frames.saturating_mul(channels as usize);
                skip_budget_initialized = true;
            }

            if config.collect_pcm {
                append_audio_buffer_to_f32_vec(
                    decoded,
                    &mut samples,
                    &mut remaining_skip_samples,
                );
            } else if frame_samples > 0 {
                // Inspect path only needs metadata; avoid full decode cost.
                break;
            }
        }
    }

    if channels == 0 || sample_rate_hz == 0 {
        return Err(
            "Decoded source produced invalid channel/sample-rate metadata.".to_string(),
        );
    }

    if duration_seconds.is_none() && config.collect_pcm {
        let frame_count = decoded_frames_total;
        duration_seconds = Some(frame_count as f64 / sample_rate_hz as f64);
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

impl DecoderBackend for RodioDecoderBackend {
    fn name(&self) -> &'static str {
        "rodio"
    }

    fn inspect(&self, data: Arc<[u8]>) -> Result<DecodedSourceInfo, String> {
        let decoder = RodioDecoder::new(BufReader::new(Cursor::new(data)))
            .map_err(|error| format!("Failed to decode audio data: {error}"))?;

        inspect_source_metadata(&decoder)
    }

    fn decode_pcm(&self, data: Arc<[u8]>) -> Result<DecodedPcmData, String> {
        decode_with_rodio_pcm(data)
    }

    fn decode_stream(
        &self,
        data: Arc<[u8]>,
        options: DecodePlaybackOptions,
    ) -> Result<Box<dyn DecodedStream>, String> {
        let source = build_rodio_playback_source(data, options)?;
        let source_info = inspect_source_metadata(&source)?;

        Ok(Box::new(RodioDecodedStream {
            descriptor: DecodedStreamDescriptor {
                source_info,
                conversion_path: "rodio:decode->skip_duration->speed",
            },
            source: Some(source),
            loop_enabled: options.loop_enabled,
        }))
    }
}

impl DecoderBackend for SymphoniaDecoderBackend {
    fn name(&self) -> &'static str {
        "symphonia"
    }

    fn inspect(&self, data: Arc<[u8]>) -> Result<DecodedSourceInfo, String> {
        decode_with_symphonia(
            data,
            SymphoniaDecodeConfig {
                start_at_seconds: 0.0,
                collect_pcm: false,
            },
        )
        .map(|decoded| decoded.source_info)
    }

    fn decode_pcm(&self, data: Arc<[u8]>) -> Result<DecodedPcmData, String> {
        let decoded = decode_with_symphonia(
            data,
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

    fn decode_stream(
        &self,
        data: Arc<[u8]>,
        options: DecodePlaybackOptions,
    ) -> Result<Box<dyn DecodedStream>, String> {
        let decoded = decode_with_symphonia(
            data,
            SymphoniaDecodeConfig {
                start_at_seconds: options.start_at_seconds,
                collect_pcm: true,
            },
        )?;

        let source_info = decoded.source_info.clone();
        let channels = source_info.channels;
        let sample_rate_hz = source_info.sample_rate_hz;

        Ok(Box::new(SymphoniaDecodedStream {
            descriptor: DecodedStreamDescriptor {
                source_info,
                conversion_path: "symphonia:decode-f32->samples-buffer->speed",
            },
            samples: Some(decoded.samples),
            channels,
            sample_rate_hz,
            playback_rate: options.playback_rate,
            loop_enabled: options.loop_enabled,
        }))
    }
}

pub fn default_decoder_backend() -> Arc<dyn DecoderBackend> {
    let backend_name = std::env::var("AONSOKU_NATIVE_DECODER")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "rodio".to_string());

    match backend_name.as_str() {
        "rodio" => Arc::new(RodioDecoderBackend),
        "symphonia" => Arc::new(SymphoniaDecoderBackend),
        unsupported => {
            eprintln!(
                "[NativeAudioSidecar][M2] unsupported decoder backend '{}', fallback to rodio",
                unsupported
            );
            Arc::new(RodioDecoderBackend)
        }
    }
}
