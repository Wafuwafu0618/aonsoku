#[cfg(target_os = "windows")]
mod wasapi_probe {
    use crate::audio::SharedPcmTrack;
    use crate::error::ExclusiveProbeError;
    use rodio::{Sample, Source};
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType,
        WindowFunction,
    };
    use std::ffi::c_void;
    use std::sync::mpsc::Receiver;
    use std::thread;
    use std::time::Duration;
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
    };

    #[derive(Debug, Clone, Copy)]
    enum ExclusiveSampleFormat {
        F32,
        I16,
    }

    const HQ_RESAMPLER_CHUNK_FRAMES: usize = 512;
    const HQ_RESAMPLER_OUTPUT_HEADROOM_GAIN: f32 = 0.89;
    const EXCLUSIVE_PENDING_MULTIPLIER_PASSTHROUGH: usize = 3;

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
                    (96, 0.955, 10)
                } else if ratio >= 4.0 {
                    (128, 0.962, 12)
                } else {
                    (160, 0.968, 14)
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
                    24
                } else {
                    20
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
                    10
                } else {
                    8
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

    #[derive(Clone)]
    struct DecodedPcmSource {
        track: SharedPcmTrack,
        cursor_sample: usize,
    }

    impl DecodedPcmSource {
        fn new(track: SharedPcmTrack) -> Result<Self, ExclusiveProbeError> {
            let channels = track.channels as usize;
            if channels == 0 || track.sample_rate_hz == 0 {
                return Err(ExclusiveProbeError {
                    code: "source-decode-failed",
                    message:
                        "Decoded source produced invalid channel/sample-rate metadata for exclusive playback."
                            .to_string(),
                });
            }

            let total_frames = track.samples.len() / channels;
            if total_frames == 0 {
                return Err(ExclusiveProbeError {
                    code: "source-decode-failed",
                    message: "Decoded source produced zero PCM frames for exclusive playback."
                        .to_string(),
                });
            }

            Ok(Self {
                track,
                cursor_sample: 0,
            })
        }
    }

    impl Iterator for DecodedPcmSource {
        type Item = f32;

        fn next(&mut self) -> Option<Self::Item> {
            let sample = self.track.samples.get(self.cursor_sample).copied()?;
            self.cursor_sample = self.cursor_sample.saturating_add(1);
            Some(sample)
        }
    }

    impl Source for DecodedPcmSource {
        fn current_frame_len(&self) -> Option<usize> {
            Some(self.track.samples.len().saturating_sub(self.cursor_sample))
        }

        fn channels(&self) -> u16 {
            self.track.channels
        }

        fn sample_rate(&self) -> u32 {
            self.track.sample_rate_hz
        }

        fn total_duration(&self) -> Option<Duration> {
            let channels = self.track.channels as usize;
            if channels == 0 || self.track.sample_rate_hz == 0 {
                return None;
            }
            let frame_count = self.track.samples.len() / channels;
            Some(Duration::from_secs_f64(
                frame_count as f64 / self.track.sample_rate_hz as f64,
            ))
        }
    }

    type ExclusivePlaybackSource =
        rodio::source::Speed<rodio::source::SkipDuration<DecodedPcmSource>>;

    fn build_exclusive_playback_source(
        track: SharedPcmTrack,
        start_at_seconds: f64,
        playback_rate: f64,
    ) -> Result<ExclusivePlaybackSource, ExclusiveProbeError> {
        let start_at_seconds = if start_at_seconds.is_finite() {
            start_at_seconds.max(0.0)
        } else {
            0.0
        };
        let playback_rate = if playback_rate.is_finite() {
            playback_rate.max(0.01)
        } else {
            1.0
        };
        let source = DecodedPcmSource::new(track)?;
        Ok(source
            .skip_duration(Duration::from_secs_f64(start_at_seconds))
            .speed(playback_rate as f32))
    }

    struct HqResampledIterator<S>
    where
        S: Source + Send,
        S::Item: Sample,
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

    trait ExclusiveSampleProducer: Send {
        fn fill_samples(
            &mut self,
            output: &mut Vec<f32>,
            max_samples: usize,
        ) -> Result<usize, ExclusiveProbeError>;
    }

    struct IteratorSampleProducer<I>
    where
        I: Iterator<Item = f32> + Send,
    {
        iterator: I,
    }

    impl<I> ExclusiveSampleProducer for IteratorSampleProducer<I>
    where
        I: Iterator<Item = f32> + Send,
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
        S: Source + Send,
        S::Item: Sample,
    {
        iterator: HqResampledIterator<S>,
    }

    impl<S> ExclusiveSampleProducer for HqSampleProducer<S>
    where
        S: Source + Send,
        S::Item: Sample,
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
        S: Source + Send,
        S::Item: Sample,
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
                    self.frame_buffer[channel] = sample.to_f32();
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
        S: Source + Send,
        S::Item: Sample,
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
        track: SharedPcmTrack,
        start_at_seconds: f64,
        playback_rate: f64,
        loop_enabled: bool,
        volume: f32,
        preferred_sample_rate_hz: Option<u32>,
        oversampling_filter_id: Option<String>,
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
                if SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST).is_err() {
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
                    track.clone(),
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

                let periodicity_hns = if default_period_hns > 0 {
                    default_period_hns
                } else if minimum_period_hns > 0 {
                    minimum_period_hns
                } else {
                    10_000
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

                let use_passthrough =
                    source_channels == channels_u16 && source_sample_rate == sample_rate;
                let hq_profile =
                    HqResamplerProfile::from_filter_id(oversampling_filter_id.as_deref());
                let resample_ratio = if source_sample_rate == 0 {
                    1.0
                } else {
                    sample_rate as f64 / source_sample_rate as f64
                };
                let resample_pre_gain = if use_passthrough {
                    1.0
                } else {
                    HQ_RESAMPLER_OUTPUT_HEADROOM_GAIN
                };
                let conversion_path_label = if use_passthrough {
                    "passthrough"
                } else {
                    "hq-sinc-resample"
                };
                eprintln!(
                    "[NativeAudioSidecar] exclusive conversion path: {}{}",
                    conversion_path_label,
                    if use_passthrough {
                        String::new()
                    } else {
                        format!(" ({})", hq_profile.as_label())
                    },
                );

                let make_sample_producer =
                    || -> Result<Box<dyn ExclusiveSampleProducer>, ExclusiveProbeError> {
                        let source = build_exclusive_playback_source(
                            track.clone(),
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
                                iterator: source.map(|sample| sample.to_f32()),
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
                let mut pending_samples = Vec::<f32>::with_capacity(
                    (buffer_frame_count as usize)
                        .saturating_mul(channels)
                        .saturating_mul(2),
                );
                let mut pending_start = 0usize;
                let mut stream_draining = false;
                let pending_buffer_multiplier = if use_passthrough {
                    EXCLUSIVE_PENDING_MULTIPLIER_PASSTHROUGH
                } else {
                    hq_pending_multiplier(hq_profile, resample_ratio)
                };
                let target_pending_samples = (buffer_frame_count as usize)
                    .saturating_mul(channels)
                    .saturating_mul(pending_buffer_multiplier);
                let refill_budget_multiplier = if use_passthrough {
                    2
                } else {
                    hq_refill_budget_multiplier(hq_profile, resample_ratio)
                };
                let refill_budget_per_cycle_samples = (buffer_frame_count as usize)
                    .saturating_mul(channels)
                    .saturating_mul(refill_budget_multiplier);
                if !use_passthrough {
                    eprintln!(
                        "[NativeAudioSidecar] hq-sinc buffering profile={} ratio={:.3} pending_mul={} refill_mul={}",
                        hq_profile.as_label(),
                        resample_ratio,
                        pending_buffer_multiplier,
                        refill_budget_multiplier
                    );
                }

                // Prime multiple buffers before Start() to reduce startup underrun/noise.
                let prime_target_samples = target_pending_samples;
                while !stream_draining
                    && (pending_samples.len().saturating_sub(pending_start))
                        < prime_target_samples
                {
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
                        &pending_samples
                            [pending_start..pending_start + initial_samples_to_write],
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
                        &pending_samples[pending_start..pending_start + writable_samples],
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
                        pending_samples.drain(..pending_start);
                        pending_start = 0;
                    }

                    // Best-effort top-up after write, with bounded per-cycle work.
                    let mut refill_budget_remaining = refill_budget_per_cycle_samples;
                    while !stream_draining
                        && refill_budget_remaining > 0
                        && (pending_samples.len().saturating_sub(pending_start))
                            < target_pending_samples
                    {
                        let available_samples = pending_samples.len().saturating_sub(pending_start);
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
    use crate::audio::SharedPcmTrack;
    use crate::error::ExclusiveProbeError;
    use std::sync::mpsc::Receiver;

    pub(crate) fn probe_default_exclusive_open() -> Result<(), ExclusiveProbeError> {
        Err(ExclusiveProbeError {
            code: "exclusive-open-unsupported",
            message: "WASAPI exclusive mode is only available on Windows.".to_string(),
        })
    }

    pub(crate) fn run_default_exclusive_playback(
        _track: SharedPcmTrack,
        _start_at_seconds: f64,
        _playback_rate: f64,
        _loop_enabled: bool,
        _volume: f32,
        _preferred_sample_rate_hz: Option<u32>,
        _oversampling_filter_id: Option<String>,
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
