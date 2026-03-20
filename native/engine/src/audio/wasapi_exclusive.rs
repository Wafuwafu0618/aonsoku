#[cfg(target_os = "windows")]
mod wasapi_probe {
    use crate::audio::{ParametricEqConfig, ParametricEqProcessor};
    use crate::error::ExclusiveProbeError;
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType,
        WindowFunction,
    };
    use std::ffi::c_void;
    use std::io::{Cursor, ErrorKind};
    use std::sync::mpsc::Receiver;
    use std::sync::Arc;
    use std::thread;
    use symphonia::core::audio::{AudioBufferRef, SampleBuffer};
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::errors::Error as SymphoniaError;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    use symphonia::default::{get_codecs, get_probe};
    use windows::core::{Error as WinError, HRESULT};
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::Media::Audio::{self, IAudioClient, IAudioRenderClient, IMMDeviceEnumerator};
    use windows::Win32::Media::{KernelStreaming, Multimedia};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_HIGHEST,
        THREAD_PRIORITY_TIME_CRITICAL,
    };

    #[derive(Debug, Clone, Copy)]
    enum ExclusiveSampleFormat {
        F32,
        I16,
    }

    const HQ_RESAMPLER_CHUNK_FRAMES: usize = 512;
    const HQ_RESAMPLER_OUTPUT_HEADROOM_GAIN: f32 = 0.89;
    const EXCLUSIVE_PENDING_MULTIPLIER_PASSTHROUGH: usize = 3;
    const EXCLUSIVE_MAX_PENDING_MULTIPLIER: usize = 8;
    const EXCLUSIVE_MAX_REFILL_BUDGET_MULTIPLIER: usize = 4;
    const EXCLUSIVE_PRIME_MULTIPLIER_HEAVY: usize = 2;
    // Heavy long-lp mode prioritizes uninterrupted playback over startup latency.
    // We keep several seconds queued, similar to HQPlayer-style deep buffering.
    const HEAVY_LONG_LP_TARGET_BUFFER_SECONDS: f64 = 10.0;
    const HEAVY_LONG_LP_PRIME_BUFFER_SECONDS: f64 = 6.0;
    const HEAVY_LONG_LP_REFILL_TRIGGER_SECONDS: f64 = 4.0;
    const HEAVY_LONG_LP_REFILL_BUDGET_SECONDS: f64 = 0.08;

    #[derive(Clone, Copy, Debug)]
    enum HqResamplerProfile {
        ShortMp,
        Mp,
        Lp,
        LongLp,
    }

    impl HqResamplerProfile {
        fn from_filter_id(filter_id: Option<&str>) -> Self {
            match filter_id {
                Some("poly-sinc-short-mp") => Self::ShortMp,
                Some("poly-sinc-mp") => Self::Mp,
                Some("poly-sinc-lp") => Self::Lp,
                Some("poly-sinc-long-lp") | Some("poly-sinc-long-ip") => Self::LongLp,
                _ => Self::Mp,
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
        // Explicit per-profile/per-ratio tiers so presets are audibly more distinct.
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

    fn hq_pending_multiplier(profile: HqResamplerProfile, ratio: f64) -> usize {
        match profile {
            HqResamplerProfile::ShortMp => {
                if ratio >= 8.0 {
                    10
                } else {
                    9
                }
            }
            HqResamplerProfile::Mp => {
                if ratio >= 8.0 {
                    14
                } else {
                    12
                }
            }
            HqResamplerProfile::Lp => {
                if ratio >= 8.0 {
                    18
                } else {
                    15
                }
            }
            HqResamplerProfile::LongLp => {
                if ratio >= 8.0 {
                    36
                } else {
                    24
                }
            }
        }
    }

    fn hq_refill_budget_multiplier(profile: HqResamplerProfile, ratio: f64) -> usize {
        match profile {
            HqResamplerProfile::ShortMp => {
                if ratio >= 8.0 {
                    4
                } else {
                    3
                }
            }
            HqResamplerProfile::Mp => {
                if ratio >= 8.0 {
                    5
                } else {
                    4
                }
            }
            HqResamplerProfile::Lp => {
                if ratio >= 8.0 {
                    7
                } else {
                    6
                }
            }
            HqResamplerProfile::LongLp => {
                if ratio >= 8.0 {
                    14
                } else {
                    10
                }
            }
        }
    }

    fn map_channel_sample(frame: &[f32], input_channels: usize, output_channel: usize) -> f32 {
        if input_channels == 0 || frame.is_empty() {
            return 0.0;
        }

        if input_channels == 1 {
            if output_channel <= 1 {
                return frame[0];
            }
            return 0.0;
        }

        if output_channel < input_channels {
            return frame[output_channel];
        }

        0.0
    }

    fn samples_for_duration(seconds: f64, sample_rate: u32, channels: usize) -> usize {
        if !seconds.is_finite() || seconds <= 0.0 || sample_rate == 0 || channels == 0 {
            return 0;
        }

        let frames = (seconds * sample_rate as f64).ceil();
        if !frames.is_finite() || frames <= 0.0 {
            return 0;
        }

        let frames_u64 = frames as u64;
        let samples_u64 = frames_u64.saturating_mul(channels as u64);
        samples_u64.min(usize::MAX as u64) as usize
    }

    fn audio_buffer_to_f32_vec(buffer: AudioBufferRef<'_>) -> Vec<f32> {
        let mut sample_buffer =
            SampleBuffer::<f32>::new(buffer.capacity() as u64, *buffer.spec());
        sample_buffer.copy_interleaved_ref(buffer);
        sample_buffer.samples().to_vec()
    }

    trait PlaybackSource: Iterator<Item = f32> {
        fn channels(&self) -> u16;
        fn sample_rate(&self) -> u32;
    }

    struct SymphoniaPlaybackSource {
        format: Box<dyn symphonia::core::formats::FormatReader>,
        decoder: Box<dyn symphonia::core::codecs::Decoder>,
        track_id: u32,
        channels: u16,
        raw_sample_rate_hz: u32,
        effective_sample_rate_hz: u32,
        playback_rate: f64,
        start_at_seconds: f64,
        skip_budget_initialized: bool,
        remaining_skip_samples: usize,
        pending_samples: Vec<f32>,
        pending_index: usize,
        exhausted: bool,
    }

    impl SymphoniaPlaybackSource {
        fn new(
            audio_data: Arc<[u8]>,
            start_at_seconds: f64,
            playback_rate: f64,
        ) -> Result<Self, ExclusiveProbeError> {
            let playback_rate = if playback_rate.is_finite() {
                playback_rate.max(0.01)
            } else {
                1.0
            };
            let start_at_seconds = if start_at_seconds.is_finite() {
                start_at_seconds.max(0.0)
            } else {
                0.0
            };

            let media_source = Cursor::new(audio_data);
            let source_stream =
                MediaSourceStream::new(Box::new(media_source), Default::default());
            let hint = Hint::new();
            let probed = get_probe()
                .format(
                    &hint,
                    source_stream,
                    &FormatOptions::default(),
                    &MetadataOptions::default(),
                )
                .map_err(|error| ExclusiveProbeError {
                    code: "source-decode-failed",
                    message: format!(
                        "Failed to probe source format for exclusive playback: {error}"
                    ),
                })?;

            let format = probed.format;
            let default_track = format.default_track().ok_or_else(|| ExclusiveProbeError {
                code: "source-decode-failed",
                message:
                    "Failed to locate default audio track for exclusive playback."
                        .to_string(),
            })?;
            if default_track.codec_params.codec == CODEC_TYPE_NULL {
                return Err(ExclusiveProbeError {
                    code: "source-decode-failed",
                    message:
                        "Default track codec is not supported for exclusive playback."
                        .to_string(),
                });
            }

            let track_id = default_track.id;
            let decoder = get_codecs()
                .make(&default_track.codec_params, &DecoderOptions::default())
                .map_err(|error| ExclusiveProbeError {
                    code: "source-decode-failed",
                    message: format!(
                        "Failed to create decoder for exclusive playback: {error}"
                    ),
                })?;

            let channels = default_track
                .codec_params
                .channels
                .map(|value| value.count() as u16)
                .unwrap_or(0);
            let raw_sample_rate_hz =
                default_track.codec_params.sample_rate.unwrap_or(0);
            let effective_sample_rate_hz =
                ((raw_sample_rate_hz as f64 * playback_rate) as u32).max(1);

            let mut source = Self {
                format,
                decoder,
                track_id,
                channels,
                raw_sample_rate_hz,
                effective_sample_rate_hz,
                playback_rate,
                start_at_seconds,
                skip_budget_initialized: start_at_seconds <= 0.0,
                remaining_skip_samples: 0,
                pending_samples: Vec::new(),
                pending_index: 0,
                exhausted: false,
            };

            if source.channels == 0 || source.raw_sample_rate_hz == 0 {
                source.refill_pending()?;
            }

            if source.channels == 0 || source.raw_sample_rate_hz == 0 {
                return Err(ExclusiveProbeError {
                    code: "source-decode-failed",
                    message:
                        "Decoded source produced invalid channel/sample-rate metadata for exclusive playback."
                            .to_string(),
                });
            }

            Ok(source)
        }

        fn refill_pending(&mut self) -> Result<(), ExclusiveProbeError> {
            self.pending_samples.clear();
            self.pending_index = 0;

            while !self.exhausted {
                let packet = match self.format.next_packet() {
                    Ok(packet) => packet,
                    Err(SymphoniaError::IoError(error))
                        if error.kind() == ErrorKind::UnexpectedEof =>
                    {
                        self.exhausted = true;
                        return Ok(());
                    }
                    Err(SymphoniaError::ResetRequired) => {
                        return Err(ExclusiveProbeError {
                            code: "source-decode-failed",
                            message:
                                "Symphonia decoder reset is required but not yet supported."
                                    .to_string(),
                        });
                    }
                    Err(error) => {
                        return Err(ExclusiveProbeError {
                            code: "source-decode-failed",
                            message: format!(
                                "Failed to read next packet for exclusive playback: {error}"
                            ),
                        });
                    }
                };

                if packet.track_id() != self.track_id {
                    continue;
                }

                {
                    let decoded = match self.decoder.decode(&packet) {
                        Ok(decoded) => decoded,
                        Err(SymphoniaError::DecodeError(_)) => continue,
                        Err(SymphoniaError::ResetRequired) => {
                            return Err(ExclusiveProbeError {
                                code: "source-decode-failed",
                                message:
                                    "Symphonia decoder reset is required but not yet supported."
                                        .to_string(),
                            });
                        }
                        Err(error) => {
                            return Err(ExclusiveProbeError {
                                code: "source-decode-failed",
                                message: format!(
                                    "Failed to decode packet for exclusive playback: {error}"
                                ),
                            });
                        }
                    };

                    if self.channels == 0 {
                        self.channels = decoded.spec().channels.count() as u16;
                    }
                    if self.raw_sample_rate_hz == 0 {
                        self.raw_sample_rate_hz = decoded.spec().rate;
                        self.effective_sample_rate_hz =
                            ((self.raw_sample_rate_hz as f64 * self.playback_rate) as u32).max(1);
                    }

                    let local_buffer = audio_buffer_to_f32_vec(decoded);
                    self.append_decoded_samples(&local_buffer);
                }
                if !self.pending_samples.is_empty() {
                    return Ok(());
                }
            }

            Ok(())
        }
    }

    impl SymphoniaPlaybackSource {
        fn append_decoded_samples(&mut self, interleaved: &[f32]) {
            if interleaved.is_empty() {
                return;
            }

            if !self.skip_budget_initialized && self.start_at_seconds > 0.0 {
                if self.raw_sample_rate_hz > 0 && self.channels > 0 {
                    let seek_start_frames =
                        (self.start_at_seconds * self.raw_sample_rate_hz as f64)
                            .floor()
                            .max(0.0) as usize;
                    self.remaining_skip_samples =
                        seek_start_frames.saturating_mul(self.channels as usize);
                }
                self.skip_budget_initialized = true;
            }

            if self.remaining_skip_samples > 0 {
                let skip = self.remaining_skip_samples.min(interleaved.len());
                self.remaining_skip_samples -= skip;
                if skip >= interleaved.len() {
                    return;
                }
                self.pending_samples
                    .extend_from_slice(&interleaved[skip..]);
                return;
            }

            self.pending_samples.extend_from_slice(interleaved);
        }
    }

    impl Iterator for SymphoniaPlaybackSource {
        type Item = f32;

        fn next(&mut self) -> Option<Self::Item> {
            loop {
                if self.pending_index < self.pending_samples.len() {
                    let sample = self.pending_samples[self.pending_index];
                    self.pending_index = self.pending_index.saturating_add(1);
                    return Some(sample);
                }

                if self.exhausted {
                    return None;
                }

                if let Err(error) = self.refill_pending() {
                    eprintln!(
                        "[NativeAudioSidecar] exclusive source decode failed: {} ({})",
                        error.message, error.code
                    );
                    self.exhausted = true;
                    return None;
                }
            }
        }
    }

    impl PlaybackSource for SymphoniaPlaybackSource {
        fn channels(&self) -> u16 {
            self.channels
        }

        fn sample_rate(&self) -> u32 {
            self.effective_sample_rate_hz
        }
    }

    fn build_exclusive_playback_source(
        audio_data: Arc<[u8]>,
        start_at_seconds: f64,
        playback_rate: f64,
    ) -> Result<SymphoniaPlaybackSource, ExclusiveProbeError> {
        SymphoniaPlaybackSource::new(audio_data, start_at_seconds, playback_rate)
    }

    struct HqResampledIterator<S>
    where
        S: PlaybackSource,
    {
        source: S,
        input_channels: usize,
        output_channels: usize,
        resampler: SincFixedIn<f32>,
        input_buffer: Vec<Vec<f32>>,
        frame_buffer: Vec<f32>,
        output_buffer: Vec<f32>,
        output_index: usize,
        source_exhausted: bool,
        tail_flushed: bool,
        failed: bool,
    }

    trait ExclusiveSampleProducer {
        fn fill_samples(
            &mut self,
            output: &mut Vec<f32>,
            max_samples: usize,
        ) -> Result<usize, ExclusiveProbeError>;
    }

    struct IteratorSampleProducer<I>
    where
        I: Iterator<Item = f32>,
    {
        iterator: I,
    }

    impl<I> ExclusiveSampleProducer for IteratorSampleProducer<I>
    where
        I: Iterator<Item = f32>,
    {
        fn fill_samples(
            &mut self,
            output: &mut Vec<f32>,
            max_samples: usize,
        ) -> Result<usize, ExclusiveProbeError> {
            if max_samples == 0 {
                return Ok(0);
            }

            let initial_len = output.len();
            for sample in self.iterator.by_ref().take(max_samples) {
                output.push(sample);
            }
            Ok(output.len().saturating_sub(initial_len))
        }
    }

    struct HqSampleProducer<S>
    where
        S: PlaybackSource,
    {
        iterator: HqResampledIterator<S>,
    }

    impl<S> ExclusiveSampleProducer for HqSampleProducer<S>
    where
        S: PlaybackSource,
    {
        fn fill_samples(
            &mut self,
            output: &mut Vec<f32>,
            max_samples: usize,
        ) -> Result<usize, ExclusiveProbeError> {
            self.iterator.fill_samples(output, max_samples)
        }
    }

    impl<S> HqResampledIterator<S>
    where
        S: PlaybackSource,
    {
        fn new(
            source: S,
            output_channels: usize,
            output_sample_rate: u32,
            profile: HqResamplerProfile,
        ) -> Result<Self, ExclusiveProbeError> {
            let input_channels = source.channels() as usize;
            let input_sample_rate = source.sample_rate();
            if input_channels == 0 || input_sample_rate == 0 {
                return Err(ExclusiveProbeError {
                    code: "source-decode-failed",
                    message:
                        "Decoded source produced invalid channel/sample-rate metadata for HQ resampler."
                            .to_string(),
                });
            }

            let ratio = output_sample_rate as f64 / input_sample_rate as f64;
            let params = build_hq_resampler_params(profile, ratio);
            eprintln!(
                "[NativeAudioSidecar] hq-sinc params profile={} ratio={:.3} sinc_len={} cutoff={:.3} osf={}",
                profile.as_label(),
                ratio,
                params.sinc_len,
                params.f_cutoff,
                params.oversampling_factor
            );

            let resampler = SincFixedIn::<f32>::new(
                ratio,
                2.0,
                params,
                HQ_RESAMPLER_CHUNK_FRAMES,
                output_channels.max(1),
            )
            .map_err(|error| ExclusiveProbeError {
                code: "exclusive-resampler-init-failed",
                message: format!("Failed to initialize HQ resampler: {error}"),
            })?;

            Ok(Self {
                source,
                input_channels,
                output_channels: output_channels.max(1),
                resampler,
                input_buffer: vec![
                    Vec::with_capacity(HQ_RESAMPLER_CHUNK_FRAMES);
                    output_channels.max(1)
                ],
                frame_buffer: vec![0.0_f32; input_channels],
                output_buffer: Vec::new(),
                output_index: 0,
                source_exhausted: false,
                tail_flushed: false,
                failed: false,
            })
        }

        fn interleave_output(&mut self, processed: &[Vec<f32>]) {
            self.output_buffer.clear();
            self.output_index = 0;

            if processed.is_empty() {
                return;
            }

            let output_frames = processed[0].len();
            self.output_buffer
                .reserve(output_frames.saturating_mul(self.output_channels));

            for frame_index in 0..output_frames {
                for channel in 0..self.output_channels {
                    let sample = processed
                        .get(channel)
                        .and_then(|ch| ch.get(frame_index))
                        .copied()
                        .unwrap_or(0.0);
                    self.output_buffer.push(sample);
                }
            }
        }

        fn refill(&mut self) -> Result<(), ExclusiveProbeError> {
            if self.source_exhausted {
                if self.tail_flushed {
                    self.output_buffer.clear();
                    self.output_index = 0;
                    return Ok(());
                }

                let processed = self
                    .resampler
                    .process_partial(None::<&[Vec<f32>]>, None)
                    .map_err(|error| ExclusiveProbeError {
                        code: "exclusive-resampler-process-failed",
                        message: format!("Failed to flush HQ resampler tail: {error}"),
                    })?;
                self.tail_flushed = true;
                self.interleave_output(&processed);
                return Ok(());
            }

            for channel in 0..self.output_channels {
                self.input_buffer[channel].clear();
            }
            let mut frames_read = 0usize;

            'read_frames: while frames_read < HQ_RESAMPLER_CHUNK_FRAMES {
                for channel in 0..self.input_channels {
                    let Some(sample) = self.source.next() else {
                        self.source_exhausted = true;
                        break 'read_frames;
                    };
                    self.frame_buffer[channel] = sample;
                }

                for output_channel in 0..self.output_channels {
                    self.input_buffer[output_channel].push(map_channel_sample(
                        &self.frame_buffer,
                        self.input_channels,
                        output_channel,
                    ));
                }
                frames_read += 1;
            }

            if frames_read == 0 {
                let processed = self
                    .resampler
                    .process_partial(None::<&[Vec<f32>]>, None)
                    .map_err(|error| ExclusiveProbeError {
                        code: "exclusive-resampler-process-failed",
                        message: format!("Failed to flush HQ resampler tail: {error}"),
                    })?;
                self.tail_flushed = true;
                self.interleave_output(&processed);
                return Ok(());
            }

            if self.source_exhausted {
                let processed = self
                    .resampler
                    .process_partial(Some(&self.input_buffer), None)
                    .map_err(|error| ExclusiveProbeError {
                        code: "exclusive-resampler-process-failed",
                        message: format!("Failed to process final HQ resampler chunk: {error}"),
                    })?;
                self.interleave_output(&processed);
                return Ok(());
            }

            let processed = self
                .resampler
                .process(&self.input_buffer, None)
                .map_err(|error| ExclusiveProbeError {
                    code: "exclusive-resampler-process-failed",
                    message: format!("Failed to process HQ resampler chunk: {error}"),
                })?;
            self.interleave_output(&processed);
            Ok(())
        }

        fn fill_samples(
            &mut self,
            output: &mut Vec<f32>,
            max_samples: usize,
        ) -> Result<usize, ExclusiveProbeError> {
            if self.failed || max_samples == 0 {
                return Ok(0);
            }

            let initial_len = output.len();
            let mut refill_stall_count = 0usize;

            while output.len().saturating_sub(initial_len) < max_samples {
                if self.output_index >= self.output_buffer.len() {
                    self.refill()?;

                    if self.output_buffer.is_empty() {
                        if self.source_exhausted && self.tail_flushed {
                            break;
                        }

                        refill_stall_count += 1;
                        if refill_stall_count >= 8 {
                            return Err(ExclusiveProbeError {
                                code: "exclusive-resampler-stalled",
                                message:
                                    "HQ resampler produced no output for multiple refill attempts."
                                        .to_string(),
                            });
                        }
                        continue;
                    }
                }

                refill_stall_count = 0;
                let remaining = max_samples.saturating_sub(output.len().saturating_sub(initial_len));
                if remaining == 0 {
                    break;
                }

                let available = self.output_buffer.len().saturating_sub(self.output_index);
                if available == 0 {
                    continue;
                }

                let copy_len = available.min(remaining);
                output.extend_from_slice(
                    &self.output_buffer[self.output_index..self.output_index + copy_len],
                );
                self.output_index += copy_len;
            }

            Ok(output.len().saturating_sub(initial_len))
        }
    }

    impl<S> Iterator for HqResampledIterator<S>
    where
        S: PlaybackSource,
    {
        type Item = f32;

        fn next(&mut self) -> Option<Self::Item> {
            if self.failed {
                return None;
            }

            while self.output_index >= self.output_buffer.len() {
                if let Err(error) = self.refill() {
                    self.failed = true;
                    eprintln!(
                        "[NativeAudioSidecar] HQ resampler failed: {} ({})",
                        error.message, error.code
                    );
                    return None;
                }

                if self.output_buffer.is_empty() && self.source_exhausted && self.tail_flushed {
                    return None;
                }
            }

            let sample = self.output_buffer[self.output_index];
            self.output_index += 1;
            Some(sample)
        }
    }

    #[derive(Clone, Copy)]
    enum ExclusiveWaveFormatStorage {
        Ex(Audio::WAVEFORMATEX),
        Ext(Audio::WAVEFORMATEXTENSIBLE),
    }

    impl ExclusiveWaveFormatStorage {
        fn as_ptr(&self) -> *const Audio::WAVEFORMATEX {
            match self {
                Self::Ex(format) => format as *const Audio::WAVEFORMATEX,
                Self::Ext(format) => {
                    format as *const Audio::WAVEFORMATEXTENSIBLE as *const Audio::WAVEFORMATEX
                }
            }
        }

        fn as_wave_format_ex(&self) -> Audio::WAVEFORMATEX {
            match self {
                Self::Ex(format) => *format,
                Self::Ext(format) => unsafe { std::ptr::addr_of!(format.Format).read_unaligned() },
            }
        }
    }

    #[derive(Clone, Copy)]
    struct ExclusiveFormatSelection {
        storage: ExclusiveWaveFormatStorage,
        sample_format: ExclusiveSampleFormat,
    }

    fn classify_audio_error(default_code: &'static str, context: &str, hr: HRESULT) -> ExclusiveProbeError {
        let code = if hr == Audio::AUDCLNT_E_DEVICE_IN_USE {
            "exclusive-device-busy"
        } else if hr == Audio::AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED {
            "exclusive-not-allowed"
        } else if hr == Audio::AUDCLNT_E_UNSUPPORTED_FORMAT {
            "exclusive-format-unsupported"
        } else if hr == Audio::AUDCLNT_E_DEVICE_INVALIDATED {
            "exclusive-device-unavailable"
        } else {
            default_code
        };

        ExclusiveProbeError {
            code,
            message: format!("{context} (HRESULT=0x{:08X})", hr.0 as u32),
        }
    }

    fn classify_windows_error(default_code: &'static str, context: &str, error: WinError) -> ExclusiveProbeError {
        classify_audio_error(default_code, context, error.code())
    }

    pub(crate) fn probe_default_exclusive_open() -> Result<(), ExclusiveProbeError> {
        unsafe {
            let init_hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            let should_uninitialize = if init_hr.is_ok() {
                true
            } else if init_hr == RPC_E_CHANGED_MODE {
                false
            } else {
                return Err(ExclusiveProbeError {
                    code: "exclusive-coinit-failed",
                    message: format!("Failed to initialize COM for WASAPI exclusive probe (HRESULT=0x{:08X}).", init_hr.0 as u32),
                });
            };

            let probe_result = (|| -> Result<(), ExclusiveProbeError> {
                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&Audio::MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|error| {
                        classify_windows_error(
                            "exclusive-device-enumeration-failed",
                            "Failed to create MMDevice enumerator for exclusive mode",
                            error,
                        )
                    })?;

                let device = enumerator
                    .GetDefaultAudioEndpoint(Audio::eRender, Audio::eConsole)
                    .map_err(|error| {
                        classify_windows_error(
                            "exclusive-default-device-unavailable",
                            "Failed to get default render device for exclusive mode",
                            error,
                        )
                    })?;

                let audio_client: IAudioClient =
                    device
                        .Activate(CLSCTX_ALL, None)
                        .map_err(|error| {
                            classify_windows_error(
                                "exclusive-audio-client-activation-failed",
                                "Failed to activate IAudioClient for exclusive mode",
                                error,
                            )
                        })?;

                let waveformatex_ptr = audio_client.GetMixFormat().map_err(|error| {
                    classify_windows_error(
                        "exclusive-mix-format-failed",
                        "Failed to query mix format for exclusive mode",
                        error,
                    )
                })?;

                let mut default_period_hns = 0_i64;
                let mut minimum_period_hns = 0_i64;
                let get_period_result = audio_client.GetDevicePeriod(
                    Some(&mut default_period_hns),
                    Some(&mut minimum_period_hns),
                );

                if let Err(error) = get_period_result {
                    CoTaskMemFree(Some(waveformatex_ptr as *const c_void));
                    return Err(classify_windows_error(
                        "exclusive-device-period-failed",
                        "Failed to query device period for exclusive mode",
                        error,
                    ));
                }

                let periodicity_hns = if default_period_hns > 0 {
                    default_period_hns
                } else if minimum_period_hns > 0 {
                    minimum_period_hns
                } else {
                    10_000 // 1ms fallback in 100ns units
                };

                let selected_format = match select_supported_exclusive_format(
                    &audio_client,
                    waveformatex_ptr,
                    "Failed to find supported exclusive format for probe",
                    &[],
                ) {
                    Ok(format) => format,
                    Err(error) => {
                        CoTaskMemFree(Some(waveformatex_ptr as *const c_void));
                        return Err(error);
                    }
                };

                let initialize_result = audio_client.Initialize(
                    Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
                    0,
                    periodicity_hns,
                    periodicity_hns,
                    selected_format.storage.as_ptr(),
                    None,
                );

                CoTaskMemFree(Some(waveformatex_ptr as *const c_void));

                if let Err(error) = initialize_result {
                    return Err(classify_windows_error(
                        "exclusive-open-failed",
                        "Failed to initialize WASAPI exclusive client",
                        error,
                    ));
                }

                let _ = audio_client.Stop();
                let _ = audio_client.Reset();
                Ok(())
            })();

            if should_uninitialize {
                CoUninitialize();
            }

            probe_result
        }
    }

    fn detect_sample_format(
        waveformatex_ptr: *const Audio::WAVEFORMATEX,
    ) -> Result<ExclusiveSampleFormat, ExclusiveProbeError> {
        unsafe {
            let waveformatex = std::ptr::read_unaligned(waveformatex_ptr);
            let format_tag = waveformatex.wFormatTag as u32;

            if format_tag == Audio::WAVE_FORMAT_PCM && waveformatex.wBitsPerSample == 16 {
                return Ok(ExclusiveSampleFormat::I16);
            }

            if format_tag == Multimedia::WAVE_FORMAT_IEEE_FLOAT && waveformatex.wBitsPerSample == 32 {
                return Ok(ExclusiveSampleFormat::F32);
            }

            if format_tag == KernelStreaming::WAVE_FORMAT_EXTENSIBLE {
                let ext_ptr = waveformatex_ptr as *const Audio::WAVEFORMATEXTENSIBLE;
                let sub_format =
                    std::ptr::addr_of!((*ext_ptr).SubFormat).read_unaligned();

                if sub_format == Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
                    && waveformatex.wBitsPerSample == 32
                {
                    return Ok(ExclusiveSampleFormat::F32);
                }

                if sub_format == KernelStreaming::KSDATAFORMAT_SUBTYPE_PCM
                    && waveformatex.wBitsPerSample == 16
                {
                    return Ok(ExclusiveSampleFormat::I16);
                }
            }
        }

        Err(ExclusiveProbeError {
            code: "exclusive-format-unsupported",
            message: "Exclusive output supports only PCM16 or Float32 target format in current build."
                .to_string(),
        })
    }

    fn build_simple_wave_format(
        format_tag: u16,
        channels: u16,
        sample_rate: u32,
        bits_per_sample: u16,
    ) -> Option<Audio::WAVEFORMATEX> {
        if channels == 0 || sample_rate == 0 || bits_per_sample == 0 {
            return None;
        }

        let bytes_per_sample = (bits_per_sample as u32).checked_div(8)?;
        let block_align_u32 = (channels as u32).checked_mul(bytes_per_sample)?;
        let block_align = u16::try_from(block_align_u32).ok()?;
        let avg_bytes_per_sec = sample_rate.checked_mul(block_align_u32)?;

        Some(Audio::WAVEFORMATEX {
            wFormatTag: format_tag,
            nChannels: channels,
            nSamplesPerSec: sample_rate,
            nAvgBytesPerSec: avg_bytes_per_sec,
            nBlockAlign: block_align,
            wBitsPerSample: bits_per_sample,
            cbSize: 0,
        })
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

    fn normalize_target_sample_rate_for_source(
        source_sample_rate: u32,
        requested_target_sample_rate: u32,
    ) -> u32 {
        if source_sample_rate == 0 || requested_target_sample_rate == 0 {
            return requested_target_sample_rate;
        }

        let source_family = classify_sample_rate_family(source_sample_rate);
        let target_family = classify_sample_rate_family(requested_target_sample_rate);

        match (source_family, target_family) {
            (Some(source_family), Some(target_family)) if source_family != target_family => {
                let adjusted = (requested_target_sample_rate as u64)
                    .saturating_mul(source_family as u64)
                    .checked_div(target_family as u64)
                    .unwrap_or(requested_target_sample_rate as u64);

                if adjusted == 0 || adjusted > u32::MAX as u64 {
                    requested_target_sample_rate
                } else {
                    adjusted as u32
                }
            }
            _ => requested_target_sample_rate,
        }
    }

    fn clone_mix_format_storage(
        waveformatex_ptr: *const Audio::WAVEFORMATEX,
    ) -> ExclusiveWaveFormatStorage {
        unsafe {
            let waveformatex = std::ptr::read_unaligned(waveformatex_ptr);
            let format_tag = waveformatex.wFormatTag as u32;

            if format_tag == KernelStreaming::WAVE_FORMAT_EXTENSIBLE && waveformatex.cbSize >= 22
            {
                let extensible =
                    std::ptr::read_unaligned(waveformatex_ptr as *const Audio::WAVEFORMATEXTENSIBLE);
                return ExclusiveWaveFormatStorage::Ext(extensible);
            }

            ExclusiveWaveFormatStorage::Ex(waveformatex)
        }
    }

    fn select_supported_exclusive_format(
        audio_client: &IAudioClient,
        waveformatex_ptr: *const Audio::WAVEFORMATEX,
        context: &str,
        preferred_formats: &[(u16, u32)],
    ) -> Result<ExclusiveFormatSelection, ExclusiveProbeError> {
        unsafe {
            let mix_format = std::ptr::read_unaligned(waveformatex_ptr);
            let mut last_hresult = Audio::AUDCLNT_E_UNSUPPORTED_FORMAT;

            let mut candidate_layouts = Vec::with_capacity(preferred_formats.len() + 1);
            for preferred in preferred_formats {
                if preferred.0 == 0 || preferred.1 == 0 {
                    continue;
                }
                if !candidate_layouts.contains(preferred) {
                    candidate_layouts.push(*preferred);
                }
            }

            for (channels, sample_rate) in &candidate_layouts {
                if let Some(float32_format) = build_simple_wave_format(
                    Multimedia::WAVE_FORMAT_IEEE_FLOAT as u16,
                    *channels,
                    *sample_rate,
                    32,
                ) {
                    let float_hr = audio_client.IsFormatSupported(
                        Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
                        &float32_format as *const Audio::WAVEFORMATEX,
                        None,
                    );
                    if float_hr.is_ok() {
                        return Ok(ExclusiveFormatSelection {
                            storage: ExclusiveWaveFormatStorage::Ex(float32_format),
                            sample_format: ExclusiveSampleFormat::F32,
                        });
                    }
                    last_hresult = float_hr;
                }

                if let Some(pcm16_format) = build_simple_wave_format(
                    Audio::WAVE_FORMAT_PCM as u16,
                    *channels,
                    *sample_rate,
                    16,
                ) {
                    let pcm_hr = audio_client.IsFormatSupported(
                        Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
                        &pcm16_format as *const Audio::WAVEFORMATEX,
                        None,
                    );
                    if pcm_hr.is_ok() {
                        return Ok(ExclusiveFormatSelection {
                            storage: ExclusiveWaveFormatStorage::Ex(pcm16_format),
                            sample_format: ExclusiveSampleFormat::I16,
                        });
                    }
                    last_hresult = pcm_hr;
                }
            }

            if let Ok(mix_sample_format) = detect_sample_format(waveformatex_ptr) {
                let mix_storage = clone_mix_format_storage(waveformatex_ptr);
                let mix_hr = audio_client.IsFormatSupported(
                    Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
                    mix_storage.as_ptr(),
                    None,
                );
                if mix_hr.is_ok() {
                    return Ok(ExclusiveFormatSelection {
                        storage: mix_storage,
                        sample_format: mix_sample_format,
                    });
                }
                last_hresult = mix_hr;
            }

            let mix_layout = (mix_format.nChannels, mix_format.nSamplesPerSec);
            if !candidate_layouts.contains(&mix_layout) {
                if let Some(float32_format) = build_simple_wave_format(
                    Multimedia::WAVE_FORMAT_IEEE_FLOAT as u16,
                    mix_layout.0,
                    mix_layout.1,
                    32,
                ) {
                    let float_hr = audio_client.IsFormatSupported(
                        Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
                        &float32_format as *const Audio::WAVEFORMATEX,
                        None,
                    );
                    if float_hr.is_ok() {
                        return Ok(ExclusiveFormatSelection {
                            storage: ExclusiveWaveFormatStorage::Ex(float32_format),
                            sample_format: ExclusiveSampleFormat::F32,
                        });
                    }
                    last_hresult = float_hr;
                }

                if let Some(pcm16_format) = build_simple_wave_format(
                    Audio::WAVE_FORMAT_PCM as u16,
                    mix_layout.0,
                    mix_layout.1,
                    16,
                ) {
                    let pcm_hr = audio_client.IsFormatSupported(
                        Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
                        &pcm16_format as *const Audio::WAVEFORMATEX,
                        None,
                    );
                    if pcm_hr.is_ok() {
                        return Ok(ExclusiveFormatSelection {
                            storage: ExclusiveWaveFormatStorage::Ex(pcm16_format),
                            sample_format: ExclusiveSampleFormat::I16,
                        });
                    }
                    last_hresult = pcm_hr;
                }
            }

            Err(classify_audio_error(
                "exclusive-format-unsupported",
                context,
                last_hresult,
            ))
        }
    }

    fn write_render_frames(
        buffer_ptr: *mut u8,
        frames_to_write: usize,
        channels: usize,
        sample_format: ExclusiveSampleFormat,
        samples: &[f32],
        pre_gain: f32,
        volume: f32,
    ) {
        let sample_count = frames_to_write * channels;

        match sample_format {
            ExclusiveSampleFormat::F32 => unsafe {
                let output = std::slice::from_raw_parts_mut(buffer_ptr as *mut f32, sample_count);
                for (index, out_sample) in output.iter_mut().enumerate() {
                    *out_sample = samples[index] * pre_gain * volume;
                }
            },
            ExclusiveSampleFormat::I16 => unsafe {
                let output = std::slice::from_raw_parts_mut(buffer_ptr as *mut i16, sample_count);
                for (index, out_sample) in output.iter_mut().enumerate() {
                    let value = (samples[index] * pre_gain * volume).clamp(-1.0, 1.0);
                    *out_sample = (value * i16::MAX as f32) as i16;
                }
            },
        }
    }

    pub(crate) fn run_default_exclusive_playback(
        audio_data: Arc<[u8]>,
        start_at_seconds: f64,
        playback_rate: f64,
        loop_enabled: bool,
        volume: f32,
        preferred_sample_rate_hz: Option<u32>,
        oversampling_filter_id: Option<String>,
        parametric_eq: Option<ParametricEqConfig>,
        stop_receiver: Receiver<()>,
    ) -> Result<bool, ExclusiveProbeError> {
        unsafe {
            let init_hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            let should_uninitialize = if init_hr.is_ok() {
                true
            } else if init_hr == RPC_E_CHANGED_MODE {
                false
            } else {
                return Err(ExclusiveProbeError {
                    code: "exclusive-coinit-failed",
                    message: format!(
                        "Failed to initialize COM for exclusive playback (HRESULT=0x{:08X}).",
                        init_hr.0 as u32
                    ),
                });
            };

            let playback_result = (|| -> Result<bool, ExclusiveProbeError> {
                if SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL).is_err()
                    && SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST).is_err()
                {
                    eprintln!(
                        "[NativeAudioSidecar] failed to raise exclusive playback thread priority"
                    );
                }

                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&Audio::MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|error| {
                        classify_windows_error(
                            "exclusive-device-enumeration-failed",
                            "Failed to create MMDevice enumerator for exclusive playback",
                            error,
                        )
                    })?;

                let device = enumerator
                    .GetDefaultAudioEndpoint(Audio::eRender, Audio::eConsole)
                    .map_err(|error| {
                        classify_windows_error(
                            "exclusive-default-device-unavailable",
                            "Failed to get default render device for exclusive playback",
                            error,
                        )
                    })?;

                let audio_client: IAudioClient =
                    device
                        .Activate(CLSCTX_ALL, None)
                        .map_err(|error| {
                            classify_windows_error(
                                "exclusive-audio-client-activation-failed",
                                "Failed to activate IAudioClient for exclusive playback",
                                error,
                            )
                        })?;

                let waveformatex_ptr = audio_client.GetMixFormat().map_err(|error| {
                    classify_windows_error(
                        "exclusive-mix-format-failed",
                        "Failed to query mix format for exclusive playback",
                        error,
                    )
                })?;

                let source = build_exclusive_playback_source(
                    audio_data.clone(),
                    start_at_seconds,
                    playback_rate,
                )?;
                let source_channels = source.channels();
                let source_sample_rate = source.sample_rate();

                if source_channels == 0 || source_sample_rate == 0 {
                    CoTaskMemFree(Some(waveformatex_ptr as *const c_void));
                    return Err(ExclusiveProbeError {
                        code: "source-decode-failed",
                        message:
                            "Decoded source produced invalid channel/sample-rate metadata for exclusive playback."
                                .to_string(),
                    });
                }

                let mut preferred_formats = Vec::with_capacity(2);
                if let Some(target_sample_rate) = preferred_sample_rate_hz {
                    let normalized_target_sample_rate =
                        normalize_target_sample_rate_for_source(
                            source_sample_rate,
                            target_sample_rate,
                        );

                    eprintln!(
                        "[NativeAudioSidecar] exclusive target sample rate requested={}Hz",
                        target_sample_rate
                    );
                    if normalized_target_sample_rate != target_sample_rate {
                        eprintln!(
                            "[NativeAudioSidecar] exclusive target sample rate adjusted for source family source={}Hz requested={}Hz adjusted={}Hz",
                            source_sample_rate,
                            target_sample_rate,
                            normalized_target_sample_rate
                        );
                    }
                    preferred_formats.push((source_channels, normalized_target_sample_rate));
                }
                preferred_formats.push((source_channels, source_sample_rate));

                let selected_format = match select_supported_exclusive_format(
                    &audio_client,
                    waveformatex_ptr,
                    "Failed to find supported exclusive format for playback",
                    &preferred_formats,
                ) {
                    Ok(value) => value,
                    Err(error) => {
                        CoTaskMemFree(Some(waveformatex_ptr as *const c_void));
                        return Err(error);
                    }
                };
                let selected_wave_format = selected_format.storage.as_wave_format_ex();
                let sample_format = selected_format.sample_format;
                let channels = selected_wave_format.nChannels as usize;
                let sample_rate = selected_wave_format.nSamplesPerSec;
                let channels_u16 = selected_wave_format.nChannels;
                let sample_format_label = match sample_format {
                    ExclusiveSampleFormat::F32 => "f32",
                    ExclusiveSampleFormat::I16 => "i16",
                };

                if channels == 0 || channels_u16 == 0 || sample_rate == 0 {
                    CoTaskMemFree(Some(waveformatex_ptr as *const c_void));
                    return Err(ExclusiveProbeError {
                        code: "exclusive-format-unsupported",
                        message:
                            "WASAPI exclusive target format returned invalid channel/sample-rate values."
                                .to_string(),
                    });
                }
                let use_passthrough =
                    source_channels == channels_u16 && source_sample_rate == sample_rate;
                let hq_profile =
                    HqResamplerProfile::from_filter_id(oversampling_filter_id.as_deref());
                let resample_ratio = if source_sample_rate == 0 {
                    1.0
                } else {
                    sample_rate as f64 / source_sample_rate as f64
                };
                let heavy_long_lp_mode = !use_passthrough
                    && matches!(hq_profile, HqResamplerProfile::LongLp)
                    && resample_ratio >= 8.0;

                eprintln!(
                    "[NativeAudioSidecar] exclusive format selected source={}ch@{}Hz -> target={}ch@{}Hz ({})",
                    source_channels, source_sample_rate, channels_u16, sample_rate, sample_format_label
                );

                let mut default_period_hns = 0_i64;
                let mut minimum_period_hns = 0_i64;
                if let Err(error) = audio_client.GetDevicePeriod(
                    Some(&mut default_period_hns),
                    Some(&mut minimum_period_hns),
                ) {
                    CoTaskMemFree(Some(waveformatex_ptr as *const c_void));
                    return Err(classify_windows_error(
                        "exclusive-device-period-failed",
                        "Failed to query device period for exclusive playback",
                        error,
                    ));
                }

                let mut periodicity_hns = if default_period_hns > 0 {
                    default_period_hns
                } else if minimum_period_hns > 0 {
                    minimum_period_hns
                } else {
                    10_000
                };
                if heavy_long_lp_mode {
                    periodicity_hns = periodicity_hns.saturating_mul(2);
                }

                let initialize_result = audio_client.Initialize(
                    Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
                    0,
                    periodicity_hns,
                    periodicity_hns,
                    selected_format.storage.as_ptr(),
                    None,
                );

                CoTaskMemFree(Some(waveformatex_ptr as *const c_void));

                if let Err(error) = initialize_result {
                    return Err(classify_windows_error(
                        "exclusive-open-failed",
                        "Failed to initialize WASAPI exclusive client for playback",
                        error,
                    ));
                }

                let buffer_frame_count = audio_client.GetBufferSize().map_err(|error| {
                    classify_windows_error(
                        "exclusive-buffer-size-failed",
                        "Failed to read WASAPI exclusive buffer size",
                        error,
                    )
                })?;

                let render_client: IAudioRenderClient = audio_client
                    .GetService::<IAudioRenderClient>()
                    .map_err(|error| {
                        classify_windows_error(
                            "exclusive-render-client-failed",
                            "Failed to create WASAPI render client",
                            error,
                        )
                    })?;

                let resample_pre_gain = if use_passthrough {
                    1.0
                } else {
                    HQ_RESAMPLER_OUTPUT_HEADROOM_GAIN
                };
                let mut parametric_eq_processor = parametric_eq
                    .as_ref()
                    .and_then(|config| ParametricEqProcessor::new(config, channels, sample_rate));
                let mut conversion_path_label = if use_passthrough {
                    "passthrough".to_string()
                } else {
                    "hq-sinc-resample".to_string()
                };
                if parametric_eq_processor.is_some() {
                    conversion_path_label.push_str("+parametric-eq");
                }
                eprintln!(
                    "[NativeAudioSidecar] exclusive conversion path: {}{}",
                    conversion_path_label,
                    if use_passthrough {
                        String::new()
                    } else {
                        format!(" ({})", hq_profile.as_label())
                    },
                );
                if heavy_long_lp_mode {
                    eprintln!(
                        "[NativeAudioSidecar] heavy long-lp mode: exclusive period doubled for stability (ratio={:.3})",
                        resample_ratio
                    );
                }

                let make_sample_producer =
                    || -> Result<Box<dyn ExclusiveSampleProducer>, ExclusiveProbeError> {
                        let source = build_exclusive_playback_source(
                            audio_data.clone(),
                            start_at_seconds,
                            playback_rate,
                        )?;

                        if source.channels() == 0 || source.sample_rate() == 0 {
                            return Err(ExclusiveProbeError {
                                code: "source-decode-failed",
                                message:
                                    "Decoded source produced invalid channel/sample-rate metadata for exclusive playback."
                                        .to_string(),
                            });
                        }

                        if use_passthrough {
                            Ok(Box::new(IteratorSampleProducer {
                                iterator: source,
                            }))
                        } else {
                            Ok(Box::new(HqSampleProducer {
                                iterator: HqResampledIterator::new(
                                    source,
                                    channels,
                                    sample_rate,
                                    hq_profile,
                                )?,
                            }))
                        }
                    };

                let mut sample_producer = make_sample_producer()?;
                let mut stream_draining = false;
                let pending_buffer_multiplier = if use_passthrough {
                    EXCLUSIVE_PENDING_MULTIPLIER_PASSTHROUGH
                } else {
                    hq_pending_multiplier(hq_profile, resample_ratio)
                };
                let target_pending_samples_raw = (buffer_frame_count as usize)
                    .saturating_mul(channels)
                    .saturating_mul(pending_buffer_multiplier);
                let target_pending_samples_cap = (buffer_frame_count as usize)
                    .saturating_mul(channels)
                    .saturating_mul(EXCLUSIVE_MAX_PENDING_MULTIPLIER);
                let mut target_pending_samples = target_pending_samples_raw.min(target_pending_samples_cap);
                if heavy_long_lp_mode {
                    let heavy_target_samples = samples_for_duration(
                        HEAVY_LONG_LP_TARGET_BUFFER_SECONDS,
                        sample_rate,
                        channels,
                    );
                    target_pending_samples = target_pending_samples.max(heavy_target_samples);
                }
                let refill_budget_multiplier = if use_passthrough {
                    2
                } else {
                    hq_refill_budget_multiplier(hq_profile, resample_ratio)
                };
                let refill_budget_per_cycle_samples_raw = (buffer_frame_count as usize)
                    .saturating_mul(channels)
                    .saturating_mul(refill_budget_multiplier);
                let refill_budget_per_cycle_samples_cap = (buffer_frame_count as usize)
                    .saturating_mul(channels)
                    .saturating_mul(EXCLUSIVE_MAX_REFILL_BUDGET_MULTIPLIER);
                let mut refill_budget_per_cycle_samples =
                    refill_budget_per_cycle_samples_raw.min(refill_budget_per_cycle_samples_cap);
                if heavy_long_lp_mode {
                    let heavy_refill_budget_samples = samples_for_duration(
                        HEAVY_LONG_LP_REFILL_BUDGET_SECONDS,
                        sample_rate,
                        channels,
                    );
                    refill_budget_per_cycle_samples =
                        refill_budget_per_cycle_samples.max(heavy_refill_budget_samples);
                }
                let refill_trigger_samples = if heavy_long_lp_mode {
                    let heavy_refill_trigger_samples = samples_for_duration(
                        HEAVY_LONG_LP_REFILL_TRIGGER_SECONDS,
                        sample_rate,
                        channels,
                    );
                    heavy_refill_trigger_samples
                        .max(target_pending_samples / 3)
                        .min(target_pending_samples)
                } else {
                    target_pending_samples
                };
                let mut pending_samples = Vec::<f32>::with_capacity(
                    target_pending_samples.max(
                        (buffer_frame_count as usize)
                            .saturating_mul(channels)
                            .saturating_mul(2),
                    ),
                );
                let mut pending_start = 0usize;
                let samples_per_second = sample_rate as f64 * channels as f64;
                let target_pending_seconds = if samples_per_second > 0.0 {
                    target_pending_samples as f64 / samples_per_second
                } else {
                    0.0
                };
                let refill_budget_seconds = if samples_per_second > 0.0 {
                    refill_budget_per_cycle_samples as f64 / samples_per_second
                } else {
                    0.0
                };
                let refill_trigger_seconds = if samples_per_second > 0.0 {
                    refill_trigger_samples as f64 / samples_per_second
                } else {
                    0.0
                };
                if !use_passthrough {
                    eprintln!(
                        "[NativeAudioSidecar] hq-sinc buffering profile={} ratio={:.3} pending_mul={} refill_mul={} targetPending={} (~{:.2}s, raw={}) refillBudget={} (~{:.3}s, raw={}) refillTrigger={} (~{:.2}s)",
                        hq_profile.as_label(),
                        resample_ratio,
                        pending_buffer_multiplier,
                        refill_budget_multiplier,
                        target_pending_samples,
                        target_pending_seconds,
                        target_pending_samples_raw,
                        refill_budget_per_cycle_samples,
                        refill_budget_seconds,
                        refill_budget_per_cycle_samples_raw,
                        refill_trigger_samples,
                        refill_trigger_seconds
                    );
                }

                // Prime multiple buffers before Start() to reduce startup underrun/noise.
                let prime_multiplier = if heavy_long_lp_mode {
                    EXCLUSIVE_PRIME_MULTIPLIER_HEAVY
                } else {
                    1
                };
                let prime_target_samples = (buffer_frame_count as usize)
                    .saturating_mul(channels)
                    .saturating_mul(prime_multiplier)
                    .min(target_pending_samples);
                let prime_target_samples = if heavy_long_lp_mode {
                    prime_target_samples
                        .max(samples_for_duration(
                            HEAVY_LONG_LP_PRIME_BUFFER_SECONDS,
                            sample_rate,
                            channels,
                        ))
                        .min(target_pending_samples)
                } else {
                    prime_target_samples
                };
                if !use_passthrough && prime_target_samples > 0 {
                    let prime_target_seconds = if samples_per_second > 0.0 {
                        prime_target_samples as f64 / samples_per_second
                    } else {
                        0.0
                    };
                    eprintln!(
                        "[NativeAudioSidecar] exclusive startup prefill target={} samples (~{:.2}s)",
                        prime_target_samples, prime_target_seconds
                    );
                }
                while !stream_draining
                    && (pending_samples.len().saturating_sub(pending_start))
                        < prime_target_samples
                {
                    if stop_receiver.try_recv().is_ok() {
                        eprintln!(
                            "[NativeAudioSidecar][M0] exclusive-render-summary conversionPath={} underrunCount=0 endedNaturally=false (stopped during startup prefill)",
                            conversion_path_label
                        );
                        audio_client.Stop().ok();
                        audio_client.Reset().ok();
                        return Ok(false);
                    }
                    let available_samples = pending_samples.len().saturating_sub(pending_start);
                    let needed_samples = prime_target_samples.saturating_sub(available_samples);
                    let added_samples =
                        sample_producer.fill_samples(&mut pending_samples, needed_samples)?;
                    if added_samples > 0 {
                        continue;
                    }

                    if !loop_enabled {
                        stream_draining = true;
                        break;
                    }

                    sample_producer = make_sample_producer()?;
                }
                let initial_available_samples = pending_samples.len().saturating_sub(pending_start);
                let initial_available_frames = initial_available_samples / channels;
                if initial_available_frames > 0 {
                    let initial_frames_to_write = initial_available_frames.min(buffer_frame_count as usize);
                    let initial_samples_to_write = initial_frames_to_write.saturating_mul(channels);

                    let initial_buffer_ptr =
                        render_client.GetBuffer(initial_frames_to_write as u32).map_err(|error| {
                            classify_windows_error(
                                "exclusive-buffer-get-failed",
                                "Failed to acquire exclusive render buffer during startup prime",
                                error,
                            )
                        })?;

                    write_render_frames(
                        initial_buffer_ptr,
                        initial_frames_to_write,
                        channels,
                        sample_format,
                        {
                            let slice = &mut pending_samples
                                [pending_start..pending_start + initial_samples_to_write];
                            if let Some(processor) = parametric_eq_processor.as_mut() {
                                processor.process_interleaved_in_place(slice);
                            }
                            slice
                        },
                        resample_pre_gain,
                        volume,
                    );

                    render_client
                        .ReleaseBuffer(initial_frames_to_write as u32, 0)
                        .map_err(|error| {
                            classify_windows_error(
                                "exclusive-buffer-release-failed",
                                "Failed to release exclusive render buffer during startup prime",
                                error,
                            )
                        })?;

                    eprintln!(
                        "[NativeAudioSidecar] exclusive startup prime wrote {} frames (buffer={} frames)",
                        initial_frames_to_write,
                        buffer_frame_count
                    );

                    pending_start += initial_samples_to_write;
                    if pending_start >= pending_samples.len() {
                        pending_samples.clear();
                        pending_start = 0;
                    }
                }

                audio_client.Start().map_err(|error| {
                    classify_windows_error(
                        "exclusive-start-failed",
                        "Failed to start WASAPI exclusive client",
                        error,
                    )
                })?;

                let mut consecutive_empty_padding = 0usize;
                let mut underrun_observations = 0u64;
                let mut underrun_window_open = false;
                loop {
                    if stop_receiver.try_recv().is_ok() {
                        eprintln!(
                            "[NativeAudioSidecar][M0] exclusive-render-summary conversionPath={} underrunCount={} endedNaturally=false",
                            conversion_path_label, underrun_observations
                        );
                        audio_client.Stop().ok();
                        audio_client.Reset().ok();
                        return Ok(false);
                    }

                    let padding = audio_client.GetCurrentPadding().map_err(|error| {
                        classify_windows_error(
                            "exclusive-padding-failed",
                            "Failed to query exclusive padding",
                            error,
                        )
                    })?;
                    if padding == 0 {
                        if !underrun_window_open {
                            underrun_observations =
                                underrun_observations.saturating_add(1);
                            underrun_window_open = true;
                        }
                        consecutive_empty_padding += 1;
                        if consecutive_empty_padding == 16 {
                            eprintln!(
                                "[NativeAudioSidecar] exclusive render loop observed repeated empty padding (possible underrun)"
                            );
                        }
                    } else {
                        consecutive_empty_padding = 0;
                        underrun_window_open = false;
                    }

                    if stream_draining
                        && padding == 0
                        && pending_start >= pending_samples.len()
                    {
                        eprintln!(
                            "[NativeAudioSidecar][M0] exclusive-render-summary conversionPath={} underrunCount={} endedNaturally=true",
                            conversion_path_label, underrun_observations
                        );
                        audio_client.Stop().ok();
                        audio_client.Reset().ok();
                        return Ok(true);
                    }

                    let writable_frames = buffer_frame_count.saturating_sub(padding) as usize;
                    if writable_frames == 0 {
                        thread::yield_now();
                        continue;
                    }

                    if stream_draining && pending_start >= pending_samples.len() {
                        thread::yield_now();
                        continue;
                    }

                    let writable_samples = writable_frames.saturating_mul(channels);
                    if writable_samples == 0 {
                        thread::yield_now();
                        continue;
                    }

                    // Refill only what is required for the imminent write first.
                    while !stream_draining
                        && (pending_samples.len().saturating_sub(pending_start))
                            < writable_samples
                    {
                        let available_samples = pending_samples.len().saturating_sub(pending_start);
                        let needed_samples = writable_samples.saturating_sub(available_samples);
                        let added_samples =
                            sample_producer.fill_samples(&mut pending_samples, needed_samples)?;
                        if added_samples > 0 {
                            continue;
                        }

                        if !loop_enabled {
                            stream_draining = true;
                            break;
                        }

                        sample_producer = make_sample_producer()?;
                    }

                    let available_samples = pending_samples.len().saturating_sub(pending_start);
                    let available_frames = available_samples / channels;
                    if available_frames == 0 {
                        thread::yield_now();
                        continue;
                    }
                    let frames_to_write = available_frames.min(writable_frames);
                    let writable_samples = frames_to_write.saturating_mul(channels);
                    if writable_samples == 0 {
                        thread::yield_now();
                        continue;
                    }

                    let buffer_ptr = match render_client.GetBuffer(frames_to_write as u32) {
                        Ok(ptr) => ptr,
                        Err(error) => {
                            let hr = error.code();
                            // In exclusive mode, available-frame accounting can occasionally race.
                            // Treat these as transient and retry next loop iteration.
                            if hr == Audio::AUDCLNT_E_BUFFER_TOO_LARGE
                                || hr == Audio::AUDCLNT_E_BUFFER_ERROR
                                || hr == Audio::AUDCLNT_E_BUFFER_OPERATION_PENDING
                            {
                                thread::yield_now();
                                continue;
                            }

                            return Err(classify_windows_error(
                                "exclusive-buffer-get-failed",
                                "Failed to acquire exclusive render buffer",
                                error,
                            ));
                        }
                    };

                    write_render_frames(
                        buffer_ptr,
                        frames_to_write,
                        channels,
                        sample_format,
                        {
                            let slice =
                                &mut pending_samples[pending_start..pending_start + writable_samples];
                            if let Some(processor) = parametric_eq_processor.as_mut() {
                                processor.process_interleaved_in_place(slice);
                            }
                            slice
                        },
                        resample_pre_gain,
                        volume,
                    );

                    render_client
                        .ReleaseBuffer(frames_to_write as u32, 0)
                        .map_err(|error| {
                            classify_windows_error(
                                "exclusive-buffer-release-failed",
                                "Failed to release exclusive render buffer",
                                error,
                            )
                        })?;

                    pending_start += writable_samples;
                    if pending_start >= pending_samples.len() {
                        pending_samples.clear();
                        pending_start = 0;
                    } else if pending_start >= 16_384
                        && pending_start >= pending_samples.len() / 2
                    {
                        let remaining = pending_samples.len().saturating_sub(pending_start);
                        pending_samples.copy_within(pending_start.., 0);
                        pending_samples.truncate(remaining);
                        pending_start = 0;
                    }

                    // Best-effort top-up after write, with bounded per-cycle work.
                    let available_before_refill =
                        pending_samples.len().saturating_sub(pending_start);
                    if available_before_refill < refill_trigger_samples {
                        let mut refill_budget_remaining = refill_budget_per_cycle_samples;
                        while !stream_draining
                            && refill_budget_remaining > 0
                            && (pending_samples.len().saturating_sub(pending_start))
                                < target_pending_samples
                        {
                            let available_samples =
                                pending_samples.len().saturating_sub(pending_start);
                            let needed_samples = target_pending_samples
                                .saturating_sub(available_samples)
                                .min(refill_budget_remaining);
                            if needed_samples == 0 {
                                break;
                            }

                            let added_samples =
                                sample_producer.fill_samples(&mut pending_samples, needed_samples)?;
                            if added_samples > 0 {
                                refill_budget_remaining =
                                    refill_budget_remaining.saturating_sub(added_samples);
                                continue;
                            }

                            if !loop_enabled {
                                stream_draining = true;
                                break;
                            }

                            sample_producer = make_sample_producer()?;
                        }
                    }
                }
            })();

            if should_uninitialize {
                CoUninitialize();
            }

            playback_result
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod wasapi_probe {
    use crate::audio::ParametricEqConfig;
    use crate::error::ExclusiveProbeError;
    use std::sync::mpsc::Receiver;
    use std::sync::Arc;

    pub(crate) fn probe_default_exclusive_open() -> Result<(), ExclusiveProbeError> {
        Err(ExclusiveProbeError {
            code: "exclusive-open-unsupported",
            message: "WASAPI exclusive mode is only available on Windows.".to_string(),
        })
    }

    pub(crate) fn run_default_exclusive_playback(
        _audio_data: Arc<[u8]>,
        _start_at_seconds: f64,
        _playback_rate: f64,
        _loop_enabled: bool,
        _volume: f32,
        _preferred_sample_rate_hz: Option<u32>,
        _oversampling_filter_id: Option<String>,
        _parametric_eq: Option<ParametricEqConfig>,
        _stop_receiver: Receiver<()>,
    ) -> Result<bool, ExclusiveProbeError> {
        Err(ExclusiveProbeError {
            code: "exclusive-open-unsupported",
            message: "WASAPI exclusive mode is only available on Windows.".to_string(),
        })
    }
}

pub(crate) use wasapi_probe::{
    probe_default_exclusive_open,
    run_default_exclusive_playback,
};
