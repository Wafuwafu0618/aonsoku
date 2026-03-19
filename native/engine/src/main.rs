use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Cursor, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use url::Url;

const DEFAULT_TRACK_DURATION_SECONDS: f64 = 300.0;
const TICK_INTERVAL_MS: u64 = 200;
const EXCLUSIVE_LOCK_FILE_NAME: &str = "aonsoku-native-audio-exclusive.lock";

fn is_exclusive_preview_enabled() -> bool {
    match std::env::var("AONSOKU_ENABLE_EXCLUSIVE_PREVIEW") {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            normalized == "1" || normalized == "true" || normalized == "yes"
        }
        Err(_) => false,
    }
}

#[derive(Debug, Clone)]
struct RuntimeError {
    code: &'static str,
    message: String,
}

impl RuntimeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
struct ExclusiveProbeError {
    code: &'static str,
    message: String,
}

#[cfg(target_os = "windows")]
mod wasapi_probe {
    use super::ExclusiveProbeError;
    use rodio::source::UniformSourceIterator;
    use rodio::{Decoder, Sample, Source};
    use std::ffi::c_void;
    use std::io::{BufReader, Cursor};
    use std::sync::mpsc::Receiver;
    use std::sync::Arc;
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

    #[derive(Debug, Clone, Copy)]
    enum ExclusiveSampleFormat {
        F32,
        I16,
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

    pub(super) fn probe_default_exclusive_open() -> Result<(), ExclusiveProbeError> {
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

                let periodicity_hns = if minimum_period_hns > 0 {
                    minimum_period_hns
                } else if default_period_hns > 0 {
                    default_period_hns
                } else {
                    10_000 // 1ms fallback in 100ns units
                };

                let selected_format = match select_supported_exclusive_format(
                    &audio_client,
                    waveformatex_ptr,
                    "Failed to find supported exclusive format for probe",
                    None,
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
        preferred_format: Option<(u16, u32)>,
    ) -> Result<ExclusiveFormatSelection, ExclusiveProbeError> {
        unsafe {
            let mix_format = std::ptr::read_unaligned(waveformatex_ptr);
            let mut last_hresult = Audio::AUDCLNT_E_UNSUPPORTED_FORMAT;

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

            let mut candidate_layouts = Vec::with_capacity(2);
            if let Some(preferred) = preferred_format {
                candidate_layouts.push(preferred);
            }
            if candidate_layouts
                .iter()
                .all(|candidate| *candidate != (mix_format.nChannels, mix_format.nSamplesPerSec))
            {
                candidate_layouts.push((mix_format.nChannels, mix_format.nSamplesPerSec));
            }

            for (channels, sample_rate) in candidate_layouts {
                if let Some(float32_format) = build_simple_wave_format(
                    Multimedia::WAVE_FORMAT_IEEE_FLOAT as u16,
                    channels,
                    sample_rate,
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
                    channels,
                    sample_rate,
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
        volume: f32,
    ) {
        let sample_count = frames_to_write * channels;

        match sample_format {
            ExclusiveSampleFormat::F32 => unsafe {
                let output = std::slice::from_raw_parts_mut(buffer_ptr as *mut f32, sample_count);
                for (index, out_sample) in output.iter_mut().enumerate() {
                    *out_sample = samples[index] * volume;
                }
            },
            ExclusiveSampleFormat::I16 => unsafe {
                let output = std::slice::from_raw_parts_mut(buffer_ptr as *mut i16, sample_count);
                for (index, out_sample) in output.iter_mut().enumerate() {
                    let value = (samples[index] * volume).clamp(-1.0, 1.0);
                    *out_sample = (value * i16::MAX as f32) as i16;
                }
            },
        }
    }

    pub(super) fn run_default_exclusive_playback(
        audio_data: Arc<[u8]>,
        start_at_seconds: f64,
        playback_rate: f64,
        loop_enabled: bool,
        volume: f32,
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

                let decoder = Decoder::new(BufReader::new(Cursor::new(audio_data.clone()))).map_err(|error| {
                    ExclusiveProbeError {
                        code: "source-decode-failed",
                        message: format!("Failed to decode source for exclusive playback: {error}"),
                    }
                })?;

                let source = decoder
                    .skip_duration(Duration::from_secs_f64(start_at_seconds.max(0.0)))
                    .speed(playback_rate.max(0.01) as f32);
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

                let selected_format = match select_supported_exclusive_format(
                    &audio_client,
                    waveformatex_ptr,
                    "Failed to find supported exclusive format for playback",
                    Some((source_channels, source_sample_rate)),
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

                let periodicity_hns = if minimum_period_hns > 0 {
                    minimum_period_hns
                } else if default_period_hns > 0 {
                    default_period_hns
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
                eprintln!(
                    "[NativeAudioSidecar] exclusive conversion path: {}",
                    if use_passthrough {
                        "passthrough"
                    } else {
                        "uniform-resample"
                    }
                );

                let mut make_sample_iterator =
                    || -> Result<Box<dyn Iterator<Item = f32> + Send>, ExclusiveProbeError> {
                        let decoder = Decoder::new(BufReader::new(Cursor::new(audio_data.clone())))
                            .map_err(|error| ExclusiveProbeError {
                                code: "source-decode-failed",
                                message: format!(
                                    "Failed to decode source for exclusive playback: {error}"
                                ),
                            })?;

                        let source = decoder
                            .skip_duration(Duration::from_secs_f64(start_at_seconds.max(0.0)))
                            .speed(playback_rate.max(0.01) as f32);

                        if source.channels() == 0 || source.sample_rate() == 0 {
                            return Err(ExclusiveProbeError {
                                code: "source-decode-failed",
                                message:
                                    "Decoded source produced invalid channel/sample-rate metadata for exclusive playback."
                                        .to_string(),
                            });
                        }

                        if use_passthrough {
                            Ok(Box::new(source.map(|sample| sample.to_f32())))
                        } else {
                            Ok(Box::new(UniformSourceIterator::<_, f32>::new(
                                source,
                                channels_u16,
                                sample_rate,
                            )))
                        }
                    };

                let mut sample_iterator = make_sample_iterator()?;
                let mut sample_buffer = Vec::<f32>::with_capacity(
                    (buffer_frame_count as usize).saturating_mul(channels),
                );
                let mut stream_draining = false;

                audio_client.Start().map_err(|error| {
                    classify_windows_error(
                        "exclusive-start-failed",
                        "Failed to start WASAPI exclusive client",
                        error,
                    )
                })?;

                loop {
                    if stop_receiver.try_recv().is_ok() {
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

                    if stream_draining && padding == 0 {
                        audio_client.Stop().ok();
                        audio_client.Reset().ok();
                        return Ok(true);
                    }

                    let writable_frames = buffer_frame_count.saturating_sub(padding) as usize;
                    if writable_frames == 0 {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }

                    if stream_draining {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }

                    let max_samples = writable_frames.saturating_mul(channels);
                    sample_buffer.clear();
                    while sample_buffer.len() < max_samples {
                        if let Some(sample) = sample_iterator.next() {
                            sample_buffer.push(sample);
                            continue;
                        }

                        if !loop_enabled {
                            stream_draining = true;
                            break;
                        }

                        sample_iterator = make_sample_iterator()?;
                    }

                    let writable_samples = sample_buffer.len() - (sample_buffer.len() % channels);
                    if writable_samples == 0 {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    let frames_to_write = writable_samples / channels;

                    let buffer_ptr = render_client.GetBuffer(frames_to_write as u32).map_err(|error| {
                        classify_windows_error(
                            "exclusive-buffer-get-failed",
                            "Failed to acquire exclusive render buffer",
                            error,
                        )
                    })?;

                    write_render_frames(
                        buffer_ptr,
                        frames_to_write,
                        channels,
                        sample_format,
                        &sample_buffer[..writable_samples],
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
    use super::ExclusiveProbeError;
    use std::sync::mpsc::Receiver;
    use std::sync::Arc;

    pub(super) fn probe_default_exclusive_open() -> Result<(), ExclusiveProbeError> {
        Err(ExclusiveProbeError {
            code: "exclusive-open-unsupported",
            message: "WASAPI exclusive mode is only available on Windows.".to_string(),
        })
    }

    pub(super) fn run_default_exclusive_playback(
        _audio_data: Arc<[u8]>,
        _start_at_seconds: f64,
        _playback_rate: f64,
        _loop_enabled: bool,
        _volume: f32,
        _stop_receiver: Receiver<()>,
    ) -> Result<bool, ExclusiveProbeError> {
        Err(ExclusiveProbeError {
            code: "exclusive-open-unsupported",
            message: "WASAPI exclusive mode is only available on Windows.".to_string(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAudioErrorPayload {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarRequest {
    kind: String,
    id: String,
    command: String,
    #[serde(default)]
    params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarResponse {
    kind: String,
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<NativeAudioErrorPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAudioEvent {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_time_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<NativeAudioErrorPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarEventEnvelope {
    kind: String,
    event: NativeAudioEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAudioDeviceInfo {
    id: String,
    name: String,
    mode: String,
    is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAudioInitializeResult {
    ok: bool,
    version: String,
    engine: String,
    message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetOutputModeParams {
    mode: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadParams {
    src: String,
    #[serde(default)]
    autoplay: bool,
    #[serde(default, rename = "loop")]
    loop_value: bool,
    #[serde(default)]
    start_at_seconds: Option<f64>,
    #[serde(default)]
    playback_rate: Option<f64>,
    #[serde(default)]
    duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeekParams {
    position_seconds: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetVolumeParams {
    volume: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetLoopParams {
    #[serde(rename = "loop")]
    loop_value: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPlaybackRateParams {
    playback_rate: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputMode {
    WasapiShared,
    WasapiExclusive,
    Asio,
}

impl OutputMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::WasapiShared => "wasapi-shared",
            Self::WasapiExclusive => "wasapi-exclusive",
            Self::Asio => "asio",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "wasapi-shared" => Some(Self::WasapiShared),
            "wasapi-exclusive" => Some(Self::WasapiExclusive),
            "asio" => Some(Self::Asio),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaybackState {
    Idle,
    Ready,
    Playing,
    Paused,
    Ended,
}

#[derive(Debug, Clone)]
struct EngineState {
    initialized: bool,
    output_mode: OutputMode,
    source: Option<String>,
    playback_state: PlaybackState,
    volume: f64,
    loop_enabled: bool,
    playback_rate: f64,
    current_time_seconds: f64,
    duration_seconds: f64,
    last_tick_instant: Option<Instant>,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            initialized: false,
            output_mode: OutputMode::WasapiShared,
            source: None,
            playback_state: PlaybackState::Idle,
            volume: 1.0,
            loop_enabled: false,
            playback_rate: 1.0,
            current_time_seconds: 0.0,
            duration_seconds: 0.0,
            last_tick_instant: None,
        }
    }
}

impl EngineState {
    fn is_playing(&self) -> bool {
        self.playback_state == PlaybackState::Playing
    }

    fn has_source(&self) -> bool {
        self.source.is_some()
    }

    fn reset_playback_session(&mut self) {
        self.source = None;
        self.playback_state = PlaybackState::Idle;
        self.loop_enabled = false;
        self.playback_rate = 1.0;
        self.current_time_seconds = 0.0;
        self.duration_seconds = 0.0;
        self.last_tick_instant = None;
    }

    fn set_current_time(&mut self, next_time: f64) {
        if self.duration_seconds > 0.0 {
            self.current_time_seconds = next_time.clamp(0.0, self.duration_seconds);
        } else {
            self.current_time_seconds = next_time.max(0.0);
        }
    }

    fn advance_clock(&mut self) -> bool {
        if !self.is_playing() {
            return false;
        }

        let now = Instant::now();
        if let Some(last_tick) = self.last_tick_instant {
            let elapsed_seconds = now.saturating_duration_since(last_tick).as_secs_f64();
            if elapsed_seconds > 0.0 {
                self.current_time_seconds += elapsed_seconds * self.playback_rate;
            }
        }
        self.last_tick_instant = Some(now);

        if self.duration_seconds <= 0.0 {
            return false;
        }

        if self.current_time_seconds < self.duration_seconds {
            return false;
        }

        if self.loop_enabled {
            self.current_time_seconds %= self.duration_seconds;
            return false;
        }

        self.current_time_seconds = self.duration_seconds;
        self.playback_state = PlaybackState::Ended;
        self.last_tick_instant = None;
        true
    }

    fn start_playback(&mut self) -> Result<(), (&'static str, &'static str)> {
        if !self.has_source() {
            return Err(("no-source", "No audio source has been loaded."));
        }

        if self.playback_state == PlaybackState::Ended {
            self.current_time_seconds = 0.0;
        }

        self.playback_state = PlaybackState::Playing;
        self.last_tick_instant = Some(Instant::now());
        Ok(())
    }

    fn pause_playback(&mut self) {
        if self.is_playing() {
            self.advance_clock();
        }

        if self.playback_state != PlaybackState::Ended {
            self.playback_state = PlaybackState::Paused;
        }
        self.last_tick_instant = None;
    }
}
#[derive(Clone)]
struct LoadedAudio {
    data: Arc<[u8]>,
}

#[derive(Clone)]
struct ExclusivePlaybackParams {
    audio_data: Arc<[u8]>,
    start_at_seconds: f64,
    playback_rate: f64,
    loop_enabled: bool,
    volume: f32,
}

struct ExclusivePlaybackSession {
    stop_sender: mpsc::Sender<()>,
    finished: Arc<AtomicBool>,
    ended_naturally: Arc<AtomicBool>,
    join_handle: Option<thread::JoinHandle<()>>,
}

impl ExclusivePlaybackSession {
    fn request_stop(&self) {
        let _ = self.stop_sender.send(());
    }

    fn is_finished(&self) -> bool {
        self.finished.load(Ordering::Relaxed)
    }

    fn ended_naturally(&self) -> bool {
        self.ended_naturally.load(Ordering::Relaxed)
    }
}

struct AudioRuntime {
    output_stream: Option<OutputStream>,
    output_handle: Option<OutputStreamHandle>,
    sink: Option<Sink>,
    loaded_audio: Option<LoadedAudio>,
    exclusive_prepared_playback: Option<ExclusivePlaybackParams>,
    exclusive_playback: Option<ExclusivePlaybackSession>,
    exclusive_playback_ended: bool,
    exclusive_lock: Option<File>,
    exclusive_lock_path: PathBuf,
    active_output_mode: OutputMode,
    exclusive_probe_verified: bool,
}

impl Default for AudioRuntime {
    fn default() -> Self {
        Self {
            output_stream: None,
            output_handle: None,
            sink: None,
            loaded_audio: None,
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
    fn can_offer_exclusive_mode(&self) -> bool {
        if !cfg!(target_os = "windows") || !is_exclusive_preview_enabled() {
            return false;
        }

        if self.exclusive_lock.is_some() {
            return true;
        }

        let lock_available = match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&self.exclusive_lock_path)
        {
            Ok(probe_lock_file) => {
                drop(probe_lock_file);
                let _ = fs::remove_file(&self.exclusive_lock_path);
                true
            }
            Err(error) => {
                if error.kind() != io::ErrorKind::AlreadyExists {
                    eprintln!(
                        "[NativeAudioSidecar] failed to probe exclusive lock ({}): {error}",
                        self.exclusive_lock_path.display()
                    );
                }
                false
            }
        };

        if !lock_available {
            return false;
        }

        // If we already opened output in this process, probing again can fail because
        // our own shared stream occupies the endpoint. In that case, trust preview gate + lock.
        if self.output_handle.is_some() {
            return true;
        }

        match wasapi_probe::probe_default_exclusive_open() {
            Ok(()) => true,
            Err(error) => {
                if error.code != "exclusive-device-busy"
                    && error.code != "exclusive-not-allowed"
                    && error.code != "exclusive-format-unsupported"
                    && error.code != "exclusive-device-unavailable"
                {
                    eprintln!(
                        "[NativeAudioSidecar] exclusive probe failed: {} ({})",
                        error.message, error.code
                    );
                }
                false
            }
        }
    }

    fn ensure_mode_resources(&mut self, mode: OutputMode) -> Result<(), RuntimeError> {
        match mode {
            OutputMode::WasapiShared => {
                self.release_exclusive_lock();
                Ok(())
            }
            OutputMode::WasapiExclusive => {
                if !is_exclusive_preview_enabled() {
                    return Err(RuntimeError::new(
                        "exclusive-preview-disabled",
                        "WASAPI exclusive preview is disabled. Set AONSOKU_ENABLE_EXCLUSIVE_PREVIEW=1 to enable.",
                    ));
                }

                self.acquire_exclusive_lock()?;

                if self.active_output_mode == OutputMode::WasapiExclusive
                    && self.exclusive_probe_verified
                {
                    return Ok(());
                }

                if let Err(error) = wasapi_probe::probe_default_exclusive_open() {
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

    fn configure_output_mode(&mut self, mode: OutputMode) -> Result<(), RuntimeError> {
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

    fn reset_output_device(&mut self) {
        self.stop_sink();
        self.output_handle = None;
        self.output_stream = None;
        self.exclusive_prepared_playback = None;
        self.exclusive_playback = None;
        self.exclusive_playback_ended = false;
    }

    fn acquire_exclusive_lock(&mut self) -> Result<(), RuntimeError> {
        if self.exclusive_lock.is_some() {
            return Ok(());
        }

        let lock_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&self.exclusive_lock_path)
            .map_err(|error| {
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

    fn release_exclusive_lock(&mut self) {
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

        if self.output_handle.is_some() {
            return Ok(());
        }

        let (stream, handle) = OutputStream::try_default()
            .map_err(|error| format!("Failed to open default output device: {error}"))?;

        self.output_stream = Some(stream);
        self.output_handle = Some(handle);

        Ok(())
    }

    fn initialize_shared_output_with_retry(&mut self) -> Result<(), String> {
        self.active_output_mode = OutputMode::WasapiShared;

        if let Err(first_error) = self.initialize_output() {
            self.output_handle = None;
            self.output_stream = None;

            return self.initialize_output().map_err(|second_error| {
                format!(
                    "{first_error} (retry failed: {second_error})"
                )
            });
        }

        Ok(())
    }

    fn stop_sink(&mut self) {
        self.stop_exclusive_playback();

        if let Some(sink) = self.sink.take() {
            sink.stop();
        }
    }

    fn clear_loaded_audio(&mut self) {
        self.stop_sink();
        self.loaded_audio = None;
        self.exclusive_prepared_playback = None;
        self.exclusive_playback_ended = false;
    }

    fn shutdown(&mut self) {
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
        let loaded_audio = self
            .loaded_audio
            .clone()
            .ok_or_else(|| "No loaded audio is available.".to_string())?;

        self.stop_exclusive_playback();
        self.exclusive_prepared_playback = Some(ExclusivePlaybackParams {
            audio_data: loaded_audio.data,
            start_at_seconds: state.current_time_seconds.max(0.0),
            playback_rate: state.playback_rate.max(0.01),
            loop_enabled: state.loop_enabled,
            volume: state.volume as f32,
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
            let playback_result = wasapi_probe::run_default_exclusive_playback(
                params.audio_data,
                params.start_at_seconds,
                params.playback_rate,
                params.loop_enabled,
                params.volume,
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

    fn decode_duration_seconds(data: Arc<[u8]>) -> Result<f64, String> {
        let decoder = Decoder::new(BufReader::new(Cursor::new(data)))
            .map_err(|error| format!("Failed to decode audio data: {error}"))?;

        let duration_seconds = decoder
            .total_duration()
            .map(|duration| duration.as_secs_f64())
            .unwrap_or(DEFAULT_TRACK_DURATION_SECONDS);

        if !duration_seconds.is_finite() || duration_seconds < 0.0 {
            return Ok(DEFAULT_TRACK_DURATION_SECONDS);
        }

        Ok(duration_seconds)
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
            let bytes =
                fs::read(path).map_err(|error| format!("Failed to read local file: {error}"))?;
            return Ok(Arc::<[u8]>::from(bytes));
        }

        let bytes =
            fs::read(src).map_err(|error| format!("Failed to read local source: {error}"))?;
        Ok(Arc::<[u8]>::from(bytes))
    }

    fn rebuild_sink_from_state(&mut self, state: &EngineState) -> Result<(), String> {
        if self.active_output_mode == OutputMode::WasapiExclusive {
            self.prepare_exclusive_playback(state)?;
            if state.is_playing() {
                self.start_exclusive_playback()?;
            }
            return Ok(());
        }

        let loaded_audio = self
            .loaded_audio
            .clone()
            .ok_or_else(|| "No loaded audio is available.".to_string())?;

        let sink = self.create_sink()?;
        sink.set_volume(state.volume as f32);

        let decoder = Decoder::new(BufReader::new(Cursor::new(loaded_audio.data.clone())))
            .map_err(|error| format!("Failed to decode loaded audio: {error}"))?;

        let source = decoder
            .skip_duration(Duration::from_secs_f64(state.current_time_seconds.max(0.0)))
            .speed(state.playback_rate.max(0.01) as f32);

        if state.loop_enabled {
            sink.append(source.repeat_infinite());
        } else {
            sink.append(source);
        }

        self.stop_sink();
        self.sink = Some(sink);

        Ok(())
    }

    fn play_sink(&mut self) {
        if self.active_output_mode == OutputMode::WasapiExclusive {
            let _ = self.start_exclusive_playback();
            return;
        }

        if let Some(sink) = &self.sink {
            sink.play();
        }
    }

    fn pause_sink(&mut self) {
        if self.active_output_mode == OutputMode::WasapiExclusive {
            self.stop_exclusive_playback();
            return;
        }

        if let Some(sink) = &self.sink {
            sink.pause();
        }
    }

    fn is_sink_empty(&mut self) -> bool {
        if self.active_output_mode == OutputMode::WasapiExclusive {
            self.cleanup_finished_exclusive_playback();
            return self.exclusive_playback_ended;
        }

        self.sink.as_ref().map(|sink| sink.empty()).unwrap_or(false)
    }
}

enum InputMessage {
    Line(String),
    Eof,
}

fn spawn_stdin_reader() -> Receiver<InputMessage> {
    let (sender, receiver) = mpsc::channel::<InputMessage>();

    thread::spawn(move || {
        let stdin = io::stdin();
        let reader = BufReader::new(stdin.lock());

        for line_result in reader.lines() {
            let line = match line_result {
                Ok(value) => value,
                Err(_) => continue,
            };

            if sender.send(InputMessage::Line(line)).is_err() {
                return;
            }
        }

        let _ = sender.send(InputMessage::Eof);
    });

    receiver
}

fn write_json_line<T: Serialize>(value: &T) -> io::Result<()> {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    serde_json::to_writer(&mut handle, value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    handle.write_all(b"\n")?;
    handle.flush()?;
    Ok(())
}

fn emit_event(
    event_type: &str,
    current_time: Option<f64>,
    duration: Option<f64>,
    error: Option<NativeAudioErrorPayload>,
) -> io::Result<()> {
    let envelope = SidecarEventEnvelope {
        kind: "event".to_string(),
        event: NativeAudioEvent {
            event_type: event_type.to_string(),
            current_time_seconds: current_time,
            duration_seconds: duration,
            error,
        },
    };
    write_json_line(&envelope)
}

fn emit_simple_event(
    event_type: &str,
    current_time: Option<f64>,
    duration: Option<f64>,
) -> io::Result<()> {
    emit_event(event_type, current_time, duration, None)
}

fn emit_error_event(code: &str, message: &str, details: Option<Value>) -> io::Result<()> {
    emit_event(
        "error",
        None,
        None,
        Some(NativeAudioErrorPayload {
            code: code.to_string(),
            message: message.to_string(),
            details,
        }),
    )
}

fn emit_response_ok(id: &str, result: Option<Value>) -> io::Result<()> {
    write_json_line(&SidecarResponse {
        kind: "response".to_string(),
        id: id.to_string(),
        ok: true,
        result,
        error: None,
    })
}

fn emit_response_error(
    id: &str,
    code: &str,
    message: &str,
    details: Option<Value>,
) -> io::Result<()> {
    write_json_line(&SidecarResponse {
        kind: "response".to_string(),
        id: id.to_string(),
        ok: false,
        result: None,
        error: Some(NativeAudioErrorPayload {
            code: code.to_string(),
            message: message.to_string(),
            details,
        }),
    })
}

fn emit_command_error(
    id: &str,
    code: &str,
    message: &str,
    details: Option<Value>,
) -> io::Result<()> {
    emit_error_event(code, message, details.clone())?;
    emit_response_error(id, code, message, details)
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, String> {
    let payload = params.ok_or_else(|| "Missing params".to_string())?;
    serde_json::from_value(payload).map_err(|error| error.to_string())
}

fn command_result_ok_value() -> Value {
    serde_json::json!({ "ok": true })
}

fn ensure_output_mode_supported(state: &EngineState, request_id: &str) -> io::Result<bool> {
    if state.output_mode != OutputMode::Asio {
        return Ok(true);
    }

    emit_command_error(
        request_id,
        "unsupported-output-mode",
        "Current build does not support ASIO output mode yet.",
        Some(serde_json::json!({ "mode": state.output_mode.as_str() })),
    )?;

    Ok(false)
}

fn run_tick(state: &mut EngineState, runtime: &mut AudioRuntime) -> io::Result<()> {
    if !state.is_playing() {
        return Ok(());
    }

    let ended_by_clock = state.advance_clock();
    let ended_by_sink = runtime.is_sink_empty();

    emit_simple_event(
        "timeupdate",
        Some(state.current_time_seconds),
        Some(state.duration_seconds),
    )?;

    if ended_by_clock || ended_by_sink {
        if state.playback_state != PlaybackState::Ended {
            state.playback_state = PlaybackState::Ended;
            state.current_time_seconds = state.duration_seconds;
            state.last_tick_instant = None;
        }

        emit_simple_event(
            "ended",
            Some(state.current_time_seconds),
            Some(state.duration_seconds),
        )?;
    }

    Ok(())
}

fn main() -> io::Result<()> {
    let receiver = spawn_stdin_reader();
    let mut state = EngineState::default();
    let mut runtime = AudioRuntime::default();

    loop {
        match receiver.recv_timeout(Duration::from_millis(TICK_INTERVAL_MS)) {
            Ok(InputMessage::Line(line)) => {
                if line.trim().is_empty() {
                    continue;
                }

                let request = match serde_json::from_str::<SidecarRequest>(&line) {
                    Ok(value) => value,
                    Err(_) => continue,
                };

                if request.kind != "request" {
                    continue;
                }

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
                            continue;
                        }

                        runtime.active_output_mode = state.output_mode;

                        if state.output_mode == OutputMode::WasapiShared {
                            if let Err(message) = runtime.initialize_shared_output_with_retry() {
                                emit_command_error(
                                    &request.id,
                                    "output-init-failed",
                                    &message,
                                    None,
                                )?;
                                continue;
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
                        let mut devices = vec![
                            NativeAudioDeviceInfo {
                                id: "default-shared".to_string(),
                                name: "Default Device (Shared)".to_string(),
                                mode: OutputMode::WasapiShared.as_str().to_string(),
                                is_default: true,
                            },
                        ];

                        if runtime.can_offer_exclusive_mode() {
                            devices.push(NativeAudioDeviceInfo {
                                id: "default-exclusive".to_string(),
                                name: "Default Device (Exclusive)".to_string(),
                                mode: OutputMode::WasapiExclusive.as_str().to_string(),
                                is_default: true,
                            });
                        }

                        emit_response_ok(
                            &request.id,
                            Some(
                                serde_json::to_value(devices)
                                    .unwrap_or_else(|_| serde_json::json!([])),
                            ),
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
                                    continue;
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
                                continue;
                            }

                            if let Err(error) = runtime.configure_output_mode(mode) {
                                let details = if error.code == "exclusive-preview-disabled" {
                                    serde_json::json!({
                                        "mode": mode.as_str(),
                                        "requiredEnv": "AONSOKU_ENABLE_EXCLUSIVE_PREVIEW"
                                    })
                                } else {
                                    serde_json::json!({
                                        "mode": mode.as_str()
                                    })
                                };

                                emit_command_error(
                                    &request.id,
                                    error.code,
                                    &error.message,
                                    Some(details),
                                )?;
                                continue;
                            }

                            state.output_mode = mode;

                            if state.has_source() {
                                if let Err(message) = runtime.rebuild_sink_from_state(&state) {
                                    emit_command_error(
                                        &request.id,
                                        "playback-pipeline-failed",
                                        &message,
                                        None,
                                    )?;
                                    continue;
                                }

                                if state.is_playing() {
                                    runtime.play_sink();
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
                    "load" => {
                        if !state.initialized {
                            emit_command_error(
                                &request.id,
                                "not-initialized",
                                "Call initialize before load.",
                                None,
                            )?;
                            continue;
                        }

                        if !ensure_output_mode_supported(&state, &request.id)? {
                            continue;
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
                                    continue;
                                }

                                if let Some(start_at_seconds) = params.start_at_seconds {
                                    if !start_at_seconds.is_finite() || start_at_seconds < 0.0 {
                                        emit_command_error(
                                            &request.id,
                                            "invalid-start-position",
                                            "startAtSeconds must be a finite number >= 0.",
                                            None,
                                        )?;
                                        continue;
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
                                        continue;
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
                                        continue;
                                    }
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
                                        continue;
                                    }
                                };

                                let duration_seconds = if let Some(duration) =
                                    params.duration_seconds
                                {
                                    duration
                                } else {
                                    match AudioRuntime::decode_duration_seconds(audio_data.clone())
                                    {
                                        Ok(duration) => duration,
                                        Err(message) => {
                                            emit_command_error(
                                                &request.id,
                                                "source-decode-failed",
                                                &message,
                                                None,
                                            )?;
                                            continue;
                                        }
                                    }
                                };

                                if let Err(error) = runtime.ensure_mode_resources(state.output_mode)
                                {
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
                                    continue;
                                }

                                runtime.active_output_mode = state.output_mode;

                                if state.output_mode == OutputMode::WasapiShared {
                                    if let Err(message) = runtime.initialize_shared_output_with_retry() {
                                        emit_command_error(
                                            &request.id,
                                            "output-init-failed",
                                            &message,
                                            None,
                                        )?;
                                        continue;
                                    }
                                } else {
                                    runtime.reset_output_device();
                                    runtime.active_output_mode = state.output_mode;
                                }

                                state.source = Some(params.src);
                                state.playback_state = PlaybackState::Ready;
                                state.loop_enabled = params.loop_value;
                                state.playback_rate = params.playback_rate.unwrap_or(1.0);
                                state.duration_seconds = duration_seconds;
                                state.set_current_time(params.start_at_seconds.unwrap_or(0.0));
                                state.last_tick_instant = None;

                                runtime.loaded_audio = Some(LoadedAudio { data: audio_data });

                                if let Err(message) = runtime.rebuild_sink_from_state(&state) {
                                    emit_command_error(
                                        &request.id,
                                        "playback-pipeline-failed",
                                        &message,
                                        None,
                                    )?;
                                    continue;
                                }

                                emit_simple_event(
                                    "loadedmetadata",
                                    Some(state.current_time_seconds),
                                    Some(state.duration_seconds),
                                )?;

                                if params.autoplay {
                                    if let Err((code, message)) = state.start_playback() {
                                        emit_command_error(&request.id, code, message, None)?;
                                        continue;
                                    }
                                    runtime.play_sink();
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
                            continue;
                        }

                        if !ensure_output_mode_supported(&state, &request.id)? {
                            continue;
                        }

                        match state.start_playback() {
                            Ok(()) => {
                                if let Err(message) = runtime.rebuild_sink_from_state(&state) {
                                    emit_command_error(
                                        &request.id,
                                        "playback-pipeline-failed",
                                        &message,
                                        None,
                                    )?;
                                    continue;
                                }
                                runtime.play_sink();
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
                            continue;
                        }

                        if !ensure_output_mode_supported(&state, &request.id)? {
                            continue;
                        }

                        if !state.has_source() {
                            emit_command_error(
                                &request.id,
                                "no-source",
                                "No audio source has been loaded.",
                                None,
                            )?;
                            continue;
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
                            continue;
                        }

                        if !ensure_output_mode_supported(&state, &request.id)? {
                            continue;
                        }

                        if !state.has_source() {
                            emit_command_error(
                                &request.id,
                                "no-source",
                                "No audio source has been loaded.",
                                None,
                            )?;
                            continue;
                        }

                        match parse_params::<SeekParams>(request.params) {
                            Ok(params) => {
                                if !params.position_seconds.is_finite()
                                    || params.position_seconds < 0.0
                                {
                                    emit_command_error(
                                        &request.id,
                                        "invalid-seek-position",
                                        "Seek position must be a finite number >= 0.",
                                        None,
                                    )?;
                                    continue;
                                }

                                if state.is_playing() {
                                    state.advance_clock();
                                }

                                state.set_current_time(params.position_seconds);
                                if state.playback_state == PlaybackState::Ended {
                                    state.playback_state = PlaybackState::Paused;
                                }

                                if let Err(message) = runtime.rebuild_sink_from_state(&state) {
                                    emit_command_error(
                                        &request.id,
                                        "playback-pipeline-failed",
                                        &message,
                                        None,
                                    )?;
                                    continue;
                                }

                                if state.is_playing() {
                                    runtime.play_sink();
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
                                continue;
                            }

                            state.volume = params.volume;
                            if runtime.active_output_mode == OutputMode::WasapiExclusive {
                                if state.has_source() {
                                    if let Err(message) = runtime.rebuild_sink_from_state(&state) {
                                        emit_command_error(
                                            &request.id,
                                            "playback-pipeline-failed",
                                            &message,
                                            None,
                                        )?;
                                        continue;
                                    }

                                    if state.is_playing() {
                                        runtime.play_sink();
                                        state.last_tick_instant = Some(Instant::now());
                                    }
                                }
                            } else if let Some(sink) = &runtime.sink {
                                sink.set_volume(params.volume as f32);
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
                                if let Err(message) = runtime.rebuild_sink_from_state(&state) {
                                    emit_command_error(
                                        &request.id,
                                        "playback-pipeline-failed",
                                        &message,
                                        None,
                                    )?;
                                    continue;
                                }

                                if state.is_playing() {
                                    runtime.play_sink();
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
                    "setPlaybackRate" => {
                        match parse_params::<SetPlaybackRateParams>(request.params) {
                            Ok(params) => {
                                if !params.playback_rate.is_finite() || params.playback_rate <= 0.0
                                {
                                    emit_command_error(
                                        &request.id,
                                        "invalid-playback-rate",
                                        "Playback rate must be a finite number > 0.",
                                        None,
                                    )?;
                                    continue;
                                }

                                if state.is_playing() {
                                    state.advance_clock();
                                }

                                state.playback_rate = params.playback_rate;

                                if state.has_source() {
                                    if let Err(message) = runtime.rebuild_sink_from_state(&state) {
                                        emit_command_error(
                                            &request.id,
                                            "playback-pipeline-failed",
                                            &message,
                                            None,
                                        )?;
                                        continue;
                                    }

                                    if state.is_playing() {
                                        runtime.play_sink();
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
                        }
                    }
                    "dispose" => {
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
            }
            Ok(InputMessage::Eof) => break,
            Err(RecvTimeoutError::Timeout) => {
                run_tick(&mut state, &mut runtime)?;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    runtime.shutdown();

    Ok(())
}
