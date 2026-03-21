#[cfg(target_os = "windows")]
mod wasapi_probe {
    use crate::audio::{ParametricEqConfig, ParametricEqProcessor};
    use crate::error::ExclusiveProbeError;
    use crate::oversampling::{self, HqResamplerProfile, OversamplingFilter};
    use std::ffi::c_void;
    use std::io::{Cursor, ErrorKind};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, TryRecvError, TrySendError};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};
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

    const HQ_RESAMPLER_OUTPUT_HEADROOM_GAIN: f32 = 0.89;
    const EXCLUSIVE_PENDING_MULTIPLIER_PASSTHROUGH: usize = 3;
    const EXCLUSIVE_MAX_PENDING_MULTIPLIER: usize = 8;
    const EXCLUSIVE_MAX_REFILL_BUDGET_MULTIPLIER: usize = 4;
    const EXCLUSIVE_PRIME_MULTIPLIER_HEAVY: usize = 2;
    // Heavy long-lp mode prioritizes uninterrupted playback over startup latency.
    // We keep several seconds queued, similar to HQPlayer-style deep buffering.
    const HEAVY_LONG_LP_TARGET_BUFFER_SECONDS: f64 = 10.0;
    const HEAVY_LONG_LP_PRIME_BUFFER_SECONDS: f64 = 1.5;
    const HEAVY_LONG_LP_REFILL_TRIGGER_SECONDS: f64 = 4.0;
    const HEAVY_LONG_LP_REFILL_BUDGET_SECONDS: f64 = 0.08;
    const HEAVY_LONG_LP_PRODUCER_CHUNK_SECONDS: f64 = 0.25;
    const HEAVY_LONG_LP_MAX_FILL_CALL_SECONDS: f64 = 0.02;
    const EXCLUSIVE_STARTUP_FADE_IN_SECONDS: f64 = 0.010;
    const EXCLUSIVE_STOP_FADE_OUT_SECONDS: f64 = 0.010;
    const EXCLUSIVE_STOP_FADE_OUT_TIMEOUT_SECONDS: f64 = 0.25;
    const EXCLUSIVE_PERF_LOG_INTERVAL: Duration = Duration::from_secs(1);
    const EXCLUSIVE_PERF_MAX_SAMPLES_PER_INTERVAL: usize = 32_768;

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

    fn percentile_from_sorted(values: &[u64], percentile: f64) -> u64 {
        if values.is_empty() {
            return 0;
        }
        let clamped = percentile.clamp(0.0, 100.0);
        let max_index = values.len().saturating_sub(1);
        let rank = ((clamped / 100.0) * max_index as f64).round() as usize;
        values[rank.min(max_index)]
    }

    struct ExclusivePerfWindow {
        started_at: Instant,
        loop_iterations: u64,
        fill_calls: u64,
        fill_samples: u64,
        fill_call_micros: Vec<u64>,
        get_buffer_calls: u64,
        get_buffer_call_micros: Vec<u64>,
        pending_last_samples: usize,
        pending_min_samples: usize,
        pending_max_samples: usize,
        underrun_last_total: u64,
    }

    impl ExclusivePerfWindow {
        fn new(initial_pending_samples: usize, initial_underrun_total: u64) -> Self {
            Self {
                started_at: Instant::now(),
                loop_iterations: 0,
                fill_calls: 0,
                fill_samples: 0,
                fill_call_micros: Vec::with_capacity(1024),
                get_buffer_calls: 0,
                get_buffer_call_micros: Vec::with_capacity(1024),
                pending_last_samples: initial_pending_samples,
                pending_min_samples: initial_pending_samples,
                pending_max_samples: initial_pending_samples,
                underrun_last_total: initial_underrun_total,
            }
        }

        fn record_iteration(&mut self) {
            self.loop_iterations = self.loop_iterations.saturating_add(1);
        }

        fn record_pending_samples(&mut self, pending_samples: usize) {
            self.pending_last_samples = pending_samples;
            self.pending_min_samples = self.pending_min_samples.min(pending_samples);
            self.pending_max_samples = self.pending_max_samples.max(pending_samples);
        }

        fn record_fill_call(&mut self, elapsed: Duration, added_samples: usize) {
            self.fill_calls = self.fill_calls.saturating_add(1);
            self.fill_samples = self.fill_samples.saturating_add(added_samples as u64);
            if self.fill_call_micros.len() < EXCLUSIVE_PERF_MAX_SAMPLES_PER_INTERVAL {
                self.fill_call_micros
                    .push(elapsed.as_micros().min(u64::MAX as u128) as u64);
            }
        }

        fn record_get_buffer_call(&mut self, elapsed: Duration) {
            self.get_buffer_calls = self.get_buffer_calls.saturating_add(1);
            if self.get_buffer_call_micros.len() < EXCLUSIVE_PERF_MAX_SAMPLES_PER_INTERVAL {
                self.get_buffer_call_micros
                    .push(elapsed.as_micros().min(u64::MAX as u128) as u64);
            }
        }

        fn maybe_log_interval(
            &mut self,
            sample_rate: u32,
            channels: usize,
            underrun_total: u64,
            conversion_path: &str,
        ) {
            if self.started_at.elapsed() < EXCLUSIVE_PERF_LOG_INTERVAL {
                return;
            }
            self.log_and_reset(sample_rate, channels, underrun_total, conversion_path);
        }

        fn flush_interval(
            &mut self,
            sample_rate: u32,
            channels: usize,
            underrun_total: u64,
            conversion_path: &str,
        ) {
            self.log_and_reset(sample_rate, channels, underrun_total, conversion_path);
        }

        fn log_and_reset(
            &mut self,
            sample_rate: u32,
            channels: usize,
            underrun_total: u64,
            conversion_path: &str,
        ) {
            let samples_per_second = sample_rate as f64 * channels.max(1) as f64;
            let to_seconds = |samples: usize| {
                if samples_per_second > 0.0 {
                    samples as f64 / samples_per_second
                } else {
                    0.0
                }
            };

            self.fill_call_micros.sort_unstable();
            let fill_p50 = percentile_from_sorted(&self.fill_call_micros, 50.0);
            let fill_p95 = percentile_from_sorted(&self.fill_call_micros, 95.0);
            let fill_p99 = percentile_from_sorted(&self.fill_call_micros, 99.0);

            self.get_buffer_call_micros.sort_unstable();
            let get_buffer_p50 = percentile_from_sorted(&self.get_buffer_call_micros, 50.0);
            let get_buffer_p95 = percentile_from_sorted(&self.get_buffer_call_micros, 95.0);
            let get_buffer_p99 = percentile_from_sorted(&self.get_buffer_call_micros, 99.0);

            let underrun_delta = underrun_total.saturating_sub(self.underrun_last_total);
            eprintln!(
                "[NativeAudioSidecar] exclusive perf 1s path={} loopIter={} underrunDelta={} underrunTotal={} pendingSec(current/min/max)={:.3}/{:.3}/{:.3} fill(calls/samples/p50/p95/p99 us)={}/{}/{}/{}/{} getBuffer(calls/p50/p95/p99 us)={}/{}/{}/{}",
                conversion_path,
                self.loop_iterations,
                underrun_delta,
                underrun_total,
                to_seconds(self.pending_last_samples),
                to_seconds(self.pending_min_samples),
                to_seconds(self.pending_max_samples),
                self.fill_calls,
                self.fill_samples,
                fill_p50,
                fill_p95,
                fill_p99,
                self.get_buffer_calls,
                get_buffer_p50,
                get_buffer_p95,
                get_buffer_p99
            );

            self.started_at = Instant::now();
            self.loop_iterations = 0;
            self.fill_calls = 0;
            self.fill_samples = 0;
            self.fill_call_micros.clear();
            self.get_buffer_calls = 0;
            self.get_buffer_call_micros.clear();
            self.pending_min_samples = self.pending_last_samples;
            self.pending_max_samples = self.pending_last_samples;
            self.underrun_last_total = underrun_total;
        }
    }

    struct ProducerThreadGuard {
        stop_flag: Arc<AtomicBool>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl ProducerThreadGuard {
        fn new(stop_flag: Arc<AtomicBool>, handle: thread::JoinHandle<()>) -> Self {
            Self {
                stop_flag,
                handle: Some(handle),
            }
        }

        fn stop_and_join(&mut self) {
            self.stop_flag.store(true, Ordering::Relaxed);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    impl Drop for ProducerThreadGuard {
        fn drop(&mut self) {
            self.stop_and_join();
        }
    }

    fn pull_samples_from_producer(
        producer_rx: &Receiver<ProducerMessage>,
        pending_samples: &mut Vec<f32>,
        pending_start: usize,
        desired_samples: usize,
        wait_for_data: bool,
        producer_finished: &mut bool,
        stream_draining: &mut bool,
    ) -> Result<(), ExclusiveProbeError> {
        while pending_samples.len().saturating_sub(pending_start) < desired_samples
            && !*producer_finished
        {
            let message = if wait_for_data {
                match producer_rx.recv_timeout(Duration::from_millis(8)) {
                    Ok(message) => Some(message),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => {
                        *producer_finished = true;
                        *stream_draining = true;
                        None
                    }
                }
            } else {
                match producer_rx.try_recv() {
                    Ok(message) => Some(message),
                    Err(TryRecvError::Empty) => None,
                    Err(TryRecvError::Disconnected) => {
                        *producer_finished = true;
                        *stream_draining = true;
                        None
                    }
                }
            };

            let Some(message) = message else {
                break;
            };
            match message {
                ProducerMessage::Samples(chunk) => {
                    pending_samples.extend_from_slice(&chunk);
                }
                ProducerMessage::EndOfStream => {
                    *producer_finished = true;
                    *stream_draining = true;
                    break;
                }
                ProducerMessage::Error(error) => return Err(error),
            }
        }

        Ok(())
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
        filter: Box<dyn OversamplingFilter>,
        input_chunk_frames: usize,
        input_chunk: Vec<f32>,
        frame_buffer: Vec<f32>,
        output_buffer: Vec<f32>,
        output_index: usize,
        source_exhausted: bool,
        tail_flushed: bool,
    }

    trait ExclusiveSampleProducer {
        fn fill_samples(
            &mut self,
            output: &mut Vec<f32>,
            max_samples: usize,
        ) -> Result<usize, ExclusiveProbeError>;
    }

    enum ProducerMessage {
        Samples(Vec<f32>),
        EndOfStream,
        Error(ExclusiveProbeError),
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
            filter_id: Option<&str>,
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

            let (filter, filter_info) = oversampling::create_filter(
                filter_id,
                input_sample_rate,
                output_sample_rate,
                output_channels.max(1),
            )
            .map_err(|message| ExclusiveProbeError {
                code: "exclusive-resampler-init-failed",
                message,
            })?;
            let input_chunk_frames = filter_info
                .map(|info| {
                    eprintln!(
                        "[NativeAudioSidecar] hq-sinc params engine={} profile={} ratio={:.3} sinc_len={} cutoff={:.3} osf={} chunkFrames={}",
                        info.engine,
                        info.filter_id,
                        info.ratio,
                        info.sinc_len,
                        info.f_cutoff,
                        info.oversampling_factor,
                        info.input_chunk_frames
                    );
                    info.input_chunk_frames
                })
                .unwrap_or(512);
            let expected_output_frames = ((input_chunk_frames as f64 * filter.ratio())
                .ceil()
                .max(1.0)) as usize;
            let output_buffer_capacity = expected_output_frames
                .saturating_mul(output_channels.max(1))
                .saturating_mul(2);

            Ok(Self {
                source,
                input_channels,
                output_channels: output_channels.max(1),
                filter,
                input_chunk_frames,
                input_chunk: Vec::with_capacity(
                    input_chunk_frames.saturating_mul(output_channels.max(1)),
                ),
                frame_buffer: vec![0.0_f32; input_channels],
                output_buffer: Vec::with_capacity(output_buffer_capacity),
                output_index: 0,
                source_exhausted: false,
                tail_flushed: false,
            })
        }

        fn refill_from_filter(&mut self, input: &[f32], is_tail_flush: bool) -> Result<(), ExclusiveProbeError> {
            self.output_buffer.clear();
            self.output_index = 0;
            let written = self
                .filter
                .process_chunk(input, &mut self.output_buffer)
                .map_err(|message| ExclusiveProbeError {
                    code: "exclusive-resampler-process-failed",
                    message,
                })?;
            if written < self.output_buffer.len() {
                self.output_buffer.truncate(written);
            }
            if is_tail_flush && written == 0 {
                self.tail_flushed = true;
            }
            Ok(())
        }

        fn refill(&mut self) -> Result<(), ExclusiveProbeError> {
            if self.source_exhausted {
                if self.tail_flushed {
                    self.output_buffer.clear();
                    self.output_index = 0;
                    return Ok(());
                }
                return self.refill_from_filter(&[], true);
            }

            self.input_chunk.clear();
            let mut frames_read = 0usize;

            'read_frames: while frames_read < self.input_chunk_frames {
                for channel in 0..self.input_channels {
                    let Some(sample) = self.source.next() else {
                        self.source_exhausted = true;
                        break 'read_frames;
                    };
                    self.frame_buffer[channel] = sample;
                }

                for output_channel in 0..self.output_channels {
                    self.input_chunk.push(map_channel_sample(
                        &self.frame_buffer,
                        self.input_channels,
                        output_channel,
                    ));
                }
                frames_read += 1;
            }

            if frames_read == 0 {
                self.source_exhausted = true;
                return self.refill();
            }

            let input_chunk = std::mem::take(&mut self.input_chunk);
            let refill_result = self.refill_from_filter(&input_chunk, false);
            self.input_chunk = input_chunk;
            refill_result
        }

        fn fill_samples(
            &mut self,
            output: &mut Vec<f32>,
            max_samples: usize,
        ) -> Result<usize, ExclusiveProbeError> {
            if max_samples == 0 {
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

    struct StartupFadeInState {
        total_frames: usize,
        remaining_frames: usize,
    }

    impl StartupFadeInState {
        fn new(sample_rate_hz: u32) -> Self {
            let total_frames = ((sample_rate_hz as f64 * EXCLUSIVE_STARTUP_FADE_IN_SECONDS).round()
                as usize)
                .max(1);
            Self {
                total_frames,
                remaining_frames: total_frames,
            }
        }

        fn remaining_frames(&self) -> usize {
            self.remaining_frames
        }

        fn next_frame_gain(&mut self) -> f32 {
            if self.remaining_frames == 0 {
                return 1.0;
            }

            let progressed_frames = self
                .total_frames
                .saturating_sub(self.remaining_frames)
                .saturating_add(1);
            self.remaining_frames = self.remaining_frames.saturating_sub(1);
            progressed_frames as f32 / self.total_frames as f32
        }
    }

    struct StopFadeOutState {
        total_frames: usize,
        remaining_frames: usize,
    }

    impl StopFadeOutState {
        fn new(sample_rate_hz: u32) -> Self {
            let total_frames = ((sample_rate_hz as f64 * EXCLUSIVE_STOP_FADE_OUT_SECONDS).round()
                as usize)
                .max(1);
            Self {
                total_frames,
                remaining_frames: total_frames,
            }
        }

        fn remaining_frames(&self) -> usize {
            self.remaining_frames
        }

        fn next_frame_gain(&mut self) -> f32 {
            if self.remaining_frames == 0 {
                return 0.0;
            }

            let gain = self.remaining_frames as f32 / self.total_frames as f32;
            self.remaining_frames = self.remaining_frames.saturating_sub(1);
            gain
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
        mut startup_fade_in: Option<&mut StartupFadeInState>,
        mut stop_fade_out: Option<&mut StopFadeOutState>,
    ) {
        let sample_count = frames_to_write * channels;

        match sample_format {
            ExclusiveSampleFormat::F32 => unsafe {
                let output = std::slice::from_raw_parts_mut(buffer_ptr as *mut f32, sample_count);
                let mut sample_index = 0usize;
                for _ in 0..frames_to_write {
                    let mut envelope_gain = 1.0_f32;
                    if let Some(state) = startup_fade_in.as_deref_mut() {
                        envelope_gain *= state.next_frame_gain();
                    }
                    if let Some(state) = stop_fade_out.as_deref_mut() {
                        envelope_gain *= state.next_frame_gain();
                    }
                    let gain = pre_gain * volume * envelope_gain;
                    for _ in 0..channels {
                        output[sample_index] = samples[sample_index] * gain;
                        sample_index += 1;
                    }
                }
            },
            ExclusiveSampleFormat::I16 => unsafe {
                let output = std::slice::from_raw_parts_mut(buffer_ptr as *mut i16, sample_count);
                let mut sample_index = 0usize;
                for _ in 0..frames_to_write {
                    let mut envelope_gain = 1.0_f32;
                    if let Some(state) = startup_fade_in.as_deref_mut() {
                        envelope_gain *= state.next_frame_gain();
                    }
                    if let Some(state) = stop_fade_out.as_deref_mut() {
                        envelope_gain *= state.next_frame_gain();
                    }
                    let gain = pre_gain * volume * envelope_gain;
                    for _ in 0..channels {
                        let value = (samples[sample_index] * gain).clamp(-1.0, 1.0);
                        output[sample_index] = (value * i16::MAX as f32) as i16;
                        sample_index += 1;
                    }
                }
            },
        }
    }

    fn write_stop_fade_out(
        audio_client: &IAudioClient,
        render_client: &IAudioRenderClient,
        channels: usize,
        sample_format: ExclusiveSampleFormat,
        pre_gain: f32,
        volume: f32,
        sample_rate: u32,
        buffer_frame_count: usize,
        pending_samples: &mut Vec<f32>,
        pending_start: &mut usize,
    ) -> Result<usize, ExclusiveProbeError> {
        let mut fade_out = StopFadeOutState::new(sample_rate);
        if fade_out.remaining_frames() == 0 {
            return Ok(0);
        }

        let mut written_total_frames = 0usize;
        let mut scratch = Vec::<f32>::new();
        let timeout = Duration::from_secs_f64(EXCLUSIVE_STOP_FADE_OUT_TIMEOUT_SECONDS);
        let deadline = Instant::now() + timeout;

        while fade_out.remaining_frames() > 0 {
            if Instant::now() >= deadline {
                eprintln!(
                    "[NativeAudioSidecar] exclusive stop fade-out timeout after {:.3}s (written={} frames remaining={})",
                    timeout.as_secs_f64(),
                    written_total_frames,
                    fade_out.remaining_frames()
                );
                break;
            }
            let padding = unsafe { audio_client.GetCurrentPadding() }.map_err(|error| {
                classify_windows_error(
                    "exclusive-padding-failed",
                    "Failed to query exclusive padding during stop fade-out",
                    error,
                )
            })?;
            let writable_frames = buffer_frame_count.saturating_sub(padding as usize);
            if writable_frames == 0 {
                thread::yield_now();
                continue;
            }

            let frames_to_write = writable_frames.min(fade_out.remaining_frames());
            let samples_to_write = frames_to_write.saturating_mul(channels);
            if scratch.len() < samples_to_write {
                scratch.resize(samples_to_write, 0.0);
            }
            scratch[..samples_to_write].fill(0.0);

            let available = pending_samples.len().saturating_sub(*pending_start);
            let copy_len = available.min(samples_to_write);
            if copy_len > 0 {
                scratch[..copy_len].copy_from_slice(
                    &pending_samples[*pending_start..*pending_start + copy_len],
                );
                *pending_start += copy_len;
                if *pending_start >= pending_samples.len() {
                    pending_samples.clear();
                    *pending_start = 0;
                }
            }

            let buffer_ptr =
                unsafe { render_client.GetBuffer(frames_to_write as u32) }.map_err(|error| {
                    classify_windows_error(
                        "exclusive-buffer-get-failed",
                        "Failed to acquire exclusive render buffer during stop fade-out",
                        error,
                    )
                })?;

            write_render_frames(
                buffer_ptr,
                frames_to_write,
                channels,
                sample_format,
                &scratch[..samples_to_write],
                pre_gain,
                volume,
                None,
                Some(&mut fade_out),
            );

            unsafe { render_client.ReleaseBuffer(frames_to_write as u32, 0) }.map_err(|error| {
                classify_windows_error(
                    "exclusive-buffer-release-failed",
                    "Failed to release exclusive render buffer during stop fade-out",
                    error,
                )
            })?;
            written_total_frames = written_total_frames.saturating_add(frames_to_write);
        }

        Ok(written_total_frames)
    }

    pub(crate) fn run_default_exclusive_playback(
        audio_data: Arc<[u8]>,
        started_flag: Arc<AtomicBool>,
        start_at_seconds: f64,
        playback_rate: f64,
        loop_enabled: bool,
        volume: f32,
        preferred_sample_rate_hz: Option<u32>,
        oversampling_filter_id: Option<String>,
        parametric_eq: Option<ParametricEqConfig>,
        stop_receiver: Receiver<()>,
    ) -> Result<bool, ExclusiveProbeError> {
        started_flag.store(false, Ordering::Relaxed);
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
                let hq_filter_label = oversampling_filter_id
                    .as_deref()
                    .map(|id| oversampling::canonical_filter_id(Some(id)))
                    .unwrap_or("sinc-m-mp");
                let hq_profile = HqResamplerProfile::from_filter_id(Some(hq_filter_label));
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
                let parametric_eq_enabled = parametric_eq
                    .as_ref()
                    .and_then(|config| ParametricEqProcessor::new(config, channels, sample_rate))
                    .is_some();
                let mut conversion_path_label = if use_passthrough {
                    "passthrough".to_string()
                } else {
                    "hq-sinc-resample".to_string()
                };
                if parametric_eq_enabled {
                    conversion_path_label.push_str("+parametric-eq");
                }
                eprintln!(
                    "[NativeAudioSidecar] exclusive conversion path: {}{}",
                    conversion_path_label,
                    if use_passthrough {
                        String::new()
                    } else {
                        format!(" ({})", hq_filter_label)
                    },
                );
                if heavy_long_lp_mode {
                    eprintln!(
                        "[NativeAudioSidecar] heavy long-lp mode: exclusive period doubled for stability (ratio={:.3})",
                        resample_ratio
                    );
                }
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
                    refill_budget_per_cycle_samples = refill_budget_per_cycle_samples
                        .min(heavy_refill_budget_samples.max(channels));
                }
                let max_fill_call_samples = if heavy_long_lp_mode {
                    samples_for_duration(
                        HEAVY_LONG_LP_MAX_FILL_CALL_SECONDS,
                        sample_rate,
                        channels,
                    )
                    .max(channels)
                } else {
                    refill_budget_per_cycle_samples.max(channels)
                };
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
                let mut perf_window =
                    ExclusivePerfWindow::new(pending_samples.len().saturating_sub(pending_start), 0);
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
                        "[NativeAudioSidecar] hq-sinc buffering profile={} ratio={:.3} pending_mul={} refill_mul={} targetPending={} (~{:.2}s, raw={}) refillBudget={} (~{:.3}s, raw={}) refillTrigger={} (~{:.2}s) maxFillPerCall={} (~{:.3}s)",
                        hq_filter_label,
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
                        refill_trigger_seconds,
                        max_fill_call_samples,
                        if samples_per_second > 0.0 {
                            max_fill_call_samples as f64 / samples_per_second
                        } else {
                            0.0
                        }
                    );
                }

                let producer_chunk_samples = if heavy_long_lp_mode {
                    samples_for_duration(
                        HEAVY_LONG_LP_PRODUCER_CHUNK_SECONDS,
                        sample_rate,
                        channels,
                    )
                    .max(channels)
                } else if use_passthrough {
                    (buffer_frame_count as usize)
                        .saturating_mul(channels)
                        .max(channels)
                } else {
                    max_fill_call_samples.max(channels)
                };
                let producer_channel_capacity = ((target_pending_samples
                    .saturating_add(producer_chunk_samples.saturating_sub(1)))
                    / producer_chunk_samples)
                    .clamp(4, 512);
                eprintln!(
                    "[NativeAudioSidecar] exclusive producer queue chunkSamples={} capacity={} (~{:.2}s buffered)",
                    producer_chunk_samples,
                    producer_channel_capacity,
                    if samples_per_second > 0.0 {
                        producer_chunk_samples
                            .saturating_mul(producer_channel_capacity) as f64
                            / samples_per_second
                    } else {
                        0.0
                    }
                );
                let (producer_tx, producer_rx) =
                    sync_channel::<ProducerMessage>(producer_channel_capacity);
                let producer_stop_flag = Arc::new(AtomicBool::new(false));
                let producer_stop_flag_for_thread = Arc::clone(&producer_stop_flag);
                let producer_audio_data = audio_data.clone();
                let producer_filter_id = oversampling_filter_id.clone();
                let producer_parametric_eq_config = parametric_eq.clone();
                let producer_conversion_path_label = conversion_path_label.clone();
                let producer_thread = thread::spawn(move || {
                    let make_sample_producer =
                        || -> Result<Box<dyn ExclusiveSampleProducer>, ExclusiveProbeError> {
                            let source = build_exclusive_playback_source(
                                producer_audio_data.clone(),
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
                                Ok(Box::new(IteratorSampleProducer { iterator: source }))
                            } else {
                                Ok(Box::new(HqSampleProducer {
                                    iterator: HqResampledIterator::new(
                                        source,
                                        channels,
                                        sample_rate,
                                        producer_filter_id.as_deref(),
                                    )?,
                                }))
                            }
                        };

                    let mut sample_producer = match make_sample_producer() {
                        Ok(producer) => producer,
                        Err(error) => {
                            eprintln!(
                                "[NativeAudioSidecar] exclusive producer failed to initialize: {} ({})",
                                error.message, error.code
                            );
                            let _ = producer_tx.try_send(ProducerMessage::Error(error));
                            return;
                        }
                    };
                    let mut producer_parametric_eq = producer_parametric_eq_config
                        .as_ref()
                        .and_then(|config| ParametricEqProcessor::new(config, channels, sample_rate));
                    let mut producer_perf_started = Instant::now();
                    let mut producer_fill_calls = 0u64;
                    let mut producer_fill_samples = 0u64;
                    let mut producer_fill_compute_micros = 0u64;
                    let mut producer_fill_call_micros = Vec::<u64>::with_capacity(1024);
                    let mut producer_send_wait_micros = 0u64;
                    let mut producer_send_wait_call_micros = Vec::<u64>::with_capacity(1024);
                    let mut producer_send_full_retries = 0u64;
                    let mut producer_send_blocked_calls = 0u64;
                    let producer_samples_per_second = sample_rate as f64 * channels as f64;

                    loop {
                        if producer_stop_flag_for_thread.load(Ordering::Relaxed) {
                            return;
                        }

                        let mut chunk = Vec::with_capacity(producer_chunk_samples);
                        let fill_started_at = Instant::now();
                        let added_samples =
                            match sample_producer.fill_samples(&mut chunk, producer_chunk_samples) {
                                Ok(value) => value,
                                Err(error) => {
                                    eprintln!(
                                        "[NativeAudioSidecar] exclusive producer fill failed: {} ({})",
                                        error.message, error.code
                                    );
                                    let _ = producer_tx.try_send(ProducerMessage::Error(error));
                                    return;
                                }
                            };
                        let fill_elapsed_us =
                            fill_started_at.elapsed().as_micros().min(u64::MAX as u128) as u64;
                        producer_fill_calls = producer_fill_calls.saturating_add(1);
                        producer_fill_samples =
                            producer_fill_samples.saturating_add(added_samples as u64);
                        producer_fill_compute_micros =
                            producer_fill_compute_micros.saturating_add(fill_elapsed_us);
                        if producer_fill_call_micros.len() < EXCLUSIVE_PERF_MAX_SAMPLES_PER_INTERVAL {
                            producer_fill_call_micros.push(fill_elapsed_us);
                        }
                        if producer_perf_started.elapsed() >= EXCLUSIVE_PERF_LOG_INTERVAL {
                            let elapsed_seconds =
                                producer_perf_started.elapsed().as_secs_f64().max(1e-6);
                            producer_fill_call_micros.sort_unstable();
                            producer_send_wait_call_micros.sort_unstable();
                            let fill_p50 =
                                percentile_from_sorted(&producer_fill_call_micros, 50.0);
                            let fill_p95 =
                                percentile_from_sorted(&producer_fill_call_micros, 95.0);
                            let fill_p99 =
                                percentile_from_sorted(&producer_fill_call_micros, 99.0);
                            let send_wait_p50 =
                                percentile_from_sorted(&producer_send_wait_call_micros, 50.0);
                            let send_wait_p95 =
                                percentile_from_sorted(&producer_send_wait_call_micros, 95.0);
                            let send_wait_p99 =
                                percentile_from_sorted(&producer_send_wait_call_micros, 99.0);
                            let realtime_factor = if producer_samples_per_second > 0.0 {
                                (producer_fill_samples as f64 / producer_samples_per_second)
                                    / elapsed_seconds
                            } else {
                                0.0
                            };
                            let compute_seconds =
                                (producer_fill_compute_micros as f64 / 1_000_000.0).max(1e-6);
                            let compute_factor = if producer_samples_per_second > 0.0 {
                                (producer_fill_samples as f64 / producer_samples_per_second)
                                    / compute_seconds
                            } else {
                                0.0
                            };
                            let queue_wait_ratio_percent =
                                (producer_send_wait_micros as f64 / 1_000_000.0)
                                    / elapsed_seconds
                                    * 100.0;
                            eprintln!(
                                "[NativeAudioSidecar] exclusive producer perf 1s path={} realtimeFactor={:.3}x computeFactor={:.3}x queueWait={:.1}% blockedCalls={} fullRetries={} fill(calls/samples/p50/p95/p99 us)={}/{}/{}/{}/{} sendWait(p50/p95/p99 us)={}/{}/{}",
                                producer_conversion_path_label,
                                realtime_factor,
                                compute_factor,
                                queue_wait_ratio_percent,
                                producer_send_blocked_calls,
                                producer_send_full_retries,
                                producer_fill_calls,
                                producer_fill_samples,
                                fill_p50,
                                fill_p95,
                                fill_p99,
                                send_wait_p50,
                                send_wait_p95,
                                send_wait_p99
                            );
                            producer_perf_started = Instant::now();
                            producer_fill_calls = 0;
                            producer_fill_samples = 0;
                            producer_fill_compute_micros = 0;
                            producer_fill_call_micros.clear();
                            producer_send_wait_micros = 0;
                            producer_send_wait_call_micros.clear();
                            producer_send_full_retries = 0;
                            producer_send_blocked_calls = 0;
                        }

                        if added_samples == 0 {
                            if loop_enabled {
                                sample_producer = match make_sample_producer() {
                                    Ok(producer) => producer,
                                    Err(error) => {
                                        eprintln!(
                                            "[NativeAudioSidecar] exclusive producer loop restart failed: {} ({})",
                                            error.message, error.code
                                        );
                                        let _ = producer_tx.try_send(ProducerMessage::Error(error));
                                        return;
                                    }
                                };
                                continue;
                            }

                            let _ = producer_tx.try_send(ProducerMessage::EndOfStream);
                            return;
                        }

                        chunk.truncate(added_samples);
                        if let Some(processor) = producer_parametric_eq.as_mut() {
                            processor.process_interleaved_in_place(&mut chunk);
                        }

                        let mut outgoing = ProducerMessage::Samples(chunk);
                        let send_wait_started_at = Instant::now();
                        let mut send_full_retries_for_call = 0u64;
                        loop {
                            if producer_stop_flag_for_thread.load(Ordering::Relaxed) {
                                return;
                            }
                            match producer_tx.try_send(outgoing) {
                                Ok(()) => break,
                                Err(TrySendError::Full(message)) => {
                                    outgoing = message;
                                    send_full_retries_for_call =
                                        send_full_retries_for_call.saturating_add(1);
                                    thread::sleep(Duration::from_millis(1));
                                }
                                Err(TrySendError::Disconnected(_)) => return,
                            }
                        }
                        let send_wait_elapsed_us =
                            send_wait_started_at.elapsed().as_micros().min(u64::MAX as u128) as u64;
                        producer_send_wait_micros =
                            producer_send_wait_micros.saturating_add(send_wait_elapsed_us);
                        if producer_send_wait_call_micros.len() < EXCLUSIVE_PERF_MAX_SAMPLES_PER_INTERVAL {
                            producer_send_wait_call_micros.push(send_wait_elapsed_us);
                        }
                        producer_send_full_retries = producer_send_full_retries
                            .saturating_add(send_full_retries_for_call);
                        if send_full_retries_for_call > 0 {
                            producer_send_blocked_calls =
                                producer_send_blocked_calls.saturating_add(1);
                        }
                    }
                });
                let mut producer_guard =
                    ProducerThreadGuard::new(Arc::clone(&producer_stop_flag), producer_thread);
                let mut producer_finished = false;

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
                        perf_window.flush_interval(sample_rate, channels, 0, &conversion_path_label);
                        producer_guard.stop_and_join();
                        eprintln!(
                            "[NativeAudioSidecar][M0] exclusive-render-summary conversionPath={} underrunCount=0 endedNaturally=false (stopped during startup prefill)",
                            conversion_path_label
                        );
                        audio_client.Stop().ok();
                        audio_client.Reset().ok();
                        return Ok(false);
                    }
                    pull_samples_from_producer(
                        &producer_rx,
                        &mut pending_samples,
                        pending_start,
                        prime_target_samples,
                        true,
                        &mut producer_finished,
                        &mut stream_draining,
                    )?;
                    perf_window
                        .record_pending_samples(pending_samples.len().saturating_sub(pending_start));
                    perf_window.maybe_log_interval(sample_rate, channels, 0, &conversion_path_label);
                }
                let mut startup_fade_in = StartupFadeInState::new(sample_rate);
                if startup_fade_in.remaining_frames() > 0 {
                    eprintln!(
                        "[NativeAudioSidecar] exclusive startup fade-in {} frames (~{:.3}s)",
                        startup_fade_in.remaining_frames(),
                        startup_fade_in.remaining_frames() as f64 / sample_rate as f64
                    );
                }
                let initial_available_samples = pending_samples.len().saturating_sub(pending_start);
                let initial_available_frames = initial_available_samples / channels;
                if initial_available_frames > 0 {
                    let initial_frames_to_write = initial_available_frames.min(buffer_frame_count as usize);
                    let initial_samples_to_write = initial_frames_to_write.saturating_mul(channels);

                    let initial_buffer_ptr = {
                        let get_buffer_started_at = Instant::now();
                        let get_buffer_result =
                            render_client.GetBuffer(initial_frames_to_write as u32);
                        perf_window.record_get_buffer_call(get_buffer_started_at.elapsed());
                        get_buffer_result
                    }
                    .map_err(|error| {
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
                        &pending_samples[pending_start..pending_start + initial_samples_to_write],
                        resample_pre_gain,
                        volume,
                        Some(&mut startup_fade_in),
                        None,
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
                    perf_window
                        .record_pending_samples(pending_samples.len().saturating_sub(pending_start));
                }

                audio_client.Start().map_err(|error| {
                    classify_windows_error(
                        "exclusive-start-failed",
                        "Failed to start WASAPI exclusive client",
                        error,
                    )
                })?;
                started_flag.store(true, Ordering::Relaxed);

                let mut consecutive_empty_padding = 0usize;
                let mut underrun_observations = 0u64;
                let mut underrun_window_open = false;
                loop {
                    if stop_receiver.try_recv().is_ok() {
                        match write_stop_fade_out(
                            &audio_client,
                            &render_client,
                            channels,
                            sample_format,
                            resample_pre_gain,
                            volume,
                            sample_rate,
                            buffer_frame_count as usize,
                            &mut pending_samples,
                            &mut pending_start,
                        ) {
                            Ok(faded_frames) if faded_frames > 0 => {
                                eprintln!(
                                    "[NativeAudioSidecar] exclusive stop fade-out wrote {} frames (~{:.3}s)",
                                    faded_frames,
                                    faded_frames as f64 / sample_rate as f64
                                );
                            }
                            Ok(_) => {}
                            Err(error) => {
                                eprintln!(
                                    "[NativeAudioSidecar] exclusive stop fade-out skipped: {} ({})",
                                    error.message, error.code
                                );
                            }
                        }
                        perf_window.flush_interval(
                            sample_rate,
                            channels,
                            underrun_observations,
                            &conversion_path_label,
                        );
                        producer_guard.stop_and_join();
                        eprintln!(
                            "[NativeAudioSidecar][M0] exclusive-render-summary conversionPath={} underrunCount={} endedNaturally=false",
                            conversion_path_label, underrun_observations
                        );
                        audio_client.Stop().ok();
                        audio_client.Reset().ok();
                        return Ok(false);
                    }
                    perf_window.record_iteration();
                    perf_window
                        .record_pending_samples(pending_samples.len().saturating_sub(pending_start));
                    perf_window.maybe_log_interval(
                        sample_rate,
                        channels,
                        underrun_observations,
                        &conversion_path_label,
                    );

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
                        perf_window.flush_interval(
                            sample_rate,
                            channels,
                            underrun_observations,
                            &conversion_path_label,
                        );
                        producer_guard.stop_and_join();
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

                    pull_samples_from_producer(
                        &producer_rx,
                        &mut pending_samples,
                        pending_start,
                        channels,
                        false,
                        &mut producer_finished,
                        &mut stream_draining,
                    )?;

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

                    let get_buffer_started_at = Instant::now();
                    let get_buffer_result = render_client.GetBuffer(frames_to_write as u32);
                    perf_window.record_get_buffer_call(get_buffer_started_at.elapsed());
                    let buffer_ptr = match get_buffer_result {
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
                        &pending_samples[pending_start..pending_start + writable_samples],
                        resample_pre_gain,
                        volume,
                        Some(&mut startup_fade_in),
                        None,
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
                    perf_window
                        .record_pending_samples(pending_samples.len().saturating_sub(pending_start));

                    // Best-effort top-up after write, with bounded per-cycle work.
                    let available_before_refill =
                        pending_samples.len().saturating_sub(pending_start);
                    if available_before_refill < refill_trigger_samples {
                        let refill_target_samples = target_pending_samples.min(
                            available_before_refill
                                .saturating_add(refill_budget_per_cycle_samples),
                        );
                        pull_samples_from_producer(
                            &producer_rx,
                            &mut pending_samples,
                            pending_start,
                            refill_target_samples,
                            false,
                            &mut producer_finished,
                            &mut stream_draining,
                        )?;
                        perf_window
                            .record_pending_samples(pending_samples.len().saturating_sub(pending_start));
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
    use std::sync::atomic::AtomicBool;
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
        _started_flag: Arc<AtomicBool>,
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
