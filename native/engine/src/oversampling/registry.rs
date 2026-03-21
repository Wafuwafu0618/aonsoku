use super::coefficients::{canonical_filter_id, FilterSpec};
use super::fft_ola::FftOlaOversamplingFilter;
use super::filter::OversamplingFilter;
use super::rubato_impl::{
    hq_resampler_chunk_frames, rubato_filter_info, HqResamplerProfile, RubatoFilterInfo,
    RubatoOversamplingFilter,
};
use super::short_fir::{integer_upsample_ratio, ShortFirOversamplingFilter};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OversamplingEngineOverride {
    Auto,
    FftOla,
    ShortFirDirect,
    RubatoSinc,
}

impl OversamplingEngineOverride {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::FftOla => "fft-ola",
            Self::ShortFirDirect => "short-fir-direct",
            Self::RubatoSinc => "rubato-sinc",
        }
    }
}

struct BypassOversamplingFilter {
    channels: usize,
}

impl BypassOversamplingFilter {
    fn new(channels: usize) -> Self {
        Self {
            channels: channels.max(1),
        }
    }
}

impl OversamplingFilter for BypassOversamplingFilter {
    fn filter_id(&self) -> &'static str {
        "bypass"
    }

    fn ratio(&self) -> f64 {
        1.0
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn process_chunk(&mut self, input: &[f32], output: &mut Vec<f32>) -> Result<usize, String> {
        output.clear();
        output.extend_from_slice(input);
        Ok(output.len())
    }

    fn reset(&mut self) {}

    fn latency_frames(&self) -> usize {
        0
    }
}

fn is_bypass_filter_id(filter_id: Option<&str>) -> bool {
    filter_id
        .map(|id| canonical_filter_id(Some(id)) == "bypass")
        .unwrap_or(false)
}

fn adjust_spec_for_integer_upsample(
    spec: &FilterSpec,
    ratio: f64,
    upsample_ratio: usize,
) -> FilterSpec {
    if !ratio.is_finite() || ratio <= 1.0 || upsample_ratio <= 1 {
        return spec.clone();
    }

    // `FilterSpec.cutoff` table is tuned for rubato's `f_cutoff` semantics
    // where 1.0 == Nyquist.
    // Our custom coefficient generator uses `2 * fc * sinc(2 * fc * t)` where
    // `fc` is normalized to sample-rate (0.5 == Nyquist), so we must convert:
    // fc_custom = f_cutoff_rubato / 2.
    //
    // NOTE:
    // Do not divide by interpolation ratio here. The polyphase fractional-delay
    // kernels run in input-sample spacing; scaling by ratio over-narrows the
    // passband and destabilizes image rejection.
    let mut adjusted = spec.clone();
    adjusted.cutoff = (adjusted.cutoff / 2.0).clamp(1.0e-6, 0.499_999);
    adjusted.oversampling_factor = resolve_custom_phase_count(spec, upsample_ratio);
    adjusted
}

fn resolve_custom_phase_count(spec: &FilterSpec, upsample_ratio: usize) -> usize {
    let default = upsample_ratio.max(1);
    let Ok(raw) = std::env::var("AONSOKU_CUSTOM_PHASE_COUNT") else {
        return default;
    };
    let parsed = raw.trim().parse::<usize>().ok();
    let Some(requested) = parsed else {
        return default;
    };
    let max_reasonable = spec.oversampling_factor.max(default).max(1);
    requested.clamp(default, max_reasonable)
}

pub fn create_filter(
    filter_id: Option<&str>,
    input_rate: u32,
    output_rate: u32,
    channels: usize,
) -> Result<(Box<dyn OversamplingFilter>, Option<RubatoFilterInfo>), String> {
    create_filter_with_engine_override(
        filter_id,
        input_rate,
        output_rate,
        channels,
        OversamplingEngineOverride::Auto,
    )
}

pub fn create_filter_with_engine_override(
    filter_id: Option<&str>,
    input_rate: u32,
    output_rate: u32,
    channels: usize,
    engine_override: OversamplingEngineOverride,
) -> Result<(Box<dyn OversamplingFilter>, Option<RubatoFilterInfo>), String> {
    if channels == 0 {
        return Err("Oversampling filter channels must be greater than zero.".to_string());
    }

    if is_bypass_filter_id(filter_id) || input_rate == output_rate {
        return Ok((Box::new(BypassOversamplingFilter::new(channels)), None));
    }

    if input_rate == 0 || output_rate == 0 {
        return Err("Sample rates must be greater than zero for oversampling.".to_string());
    }

    let normalized_filter_id = filter_id
        .map(|id| canonical_filter_id(Some(id)))
        .unwrap_or("sinc-m-mp");
    let profile = HqResamplerProfile::from_filter_id(Some(normalized_filter_id));
    let ratio = output_rate as f64 / input_rate as f64;
    let spec = FilterSpec::from_filter_id(normalized_filter_id, ratio);
    let integer_ratio = integer_upsample_ratio(ratio).filter(|value| *value > 1);
    let integer_ratio_candidate = integer_ratio.is_some();
    let adjusted_spec = if let Some(upsample_ratio) = integer_ratio {
        adjust_spec_for_integer_upsample(&spec, ratio, upsample_ratio)
    } else {
        spec.clone()
    };

    // Phase 4: long-lp is served by the custom FFT OLA path.
    let is_fft_ola_candidate =
        matches!(profile, HqResamplerProfile::LongLp)
            && spec.num_taps > 0
            && integer_ratio_candidate;

    // Phase 3: short/medium profiles are served by the custom direct FIR path.
    let is_short_direct_candidate =
        spec.num_taps <= 2048
            && integer_ratio_candidate;

    let build_fft_ola = || -> Result<(Box<dyn OversamplingFilter>, Option<RubatoFilterInfo>), String> {
        let max_input_frames = resolve_fft_ola_chunk_frames(profile, ratio);
        let filter = FftOlaOversamplingFilter::new(
            normalized_filter_id,
            ratio,
            channels,
            adjusted_spec.clone(),
            max_input_frames,
        )?;
        let mut info = rubato_filter_info(normalized_filter_id, profile, ratio);
        info.engine = "fft-ola";
        info.f_cutoff = adjusted_spec.cutoff as f32;
        info.oversampling_factor = adjusted_spec.oversampling_factor;
        info.input_chunk_frames = max_input_frames;
        Ok((Box::new(filter), Some(info)))
    };
    let build_short_direct =
        || -> Result<(Box<dyn OversamplingFilter>, Option<RubatoFilterInfo>), String> {
            let filter = ShortFirOversamplingFilter::new(
                normalized_filter_id,
                ratio,
                channels,
                adjusted_spec.clone(),
            )?;
            let mut info = rubato_filter_info(normalized_filter_id, profile, ratio);
            info.engine = "short-fir-direct";
            info.f_cutoff = adjusted_spec.cutoff as f32;
            info.oversampling_factor = adjusted_spec.oversampling_factor;
            Ok((Box::new(filter), Some(info)))
        };
    let build_rubato = || -> Result<(Box<dyn OversamplingFilter>, Option<RubatoFilterInfo>), String> {
        let (filter, info) =
            RubatoOversamplingFilter::new(normalized_filter_id, profile, ratio, channels)?;
        Ok((Box::new(filter), Some(info)))
    };

    match engine_override {
        OversamplingEngineOverride::Auto => {
            if is_fft_ola_candidate {
                return build_fft_ola();
            }
            if is_short_direct_candidate {
                return build_short_direct();
            }
            build_rubato()
        }
        OversamplingEngineOverride::FftOla => {
            if is_fft_ola_candidate {
                return build_fft_ola();
            }
            Err(format!(
                "Forced engine '{}' is not available for filter='{}' ratio={ratio:.6} (requires long profile + integer upsample ratio > 1).",
                engine_override.as_str(),
                normalized_filter_id
            ))
        }
        OversamplingEngineOverride::ShortFirDirect => {
            if is_short_direct_candidate {
                return build_short_direct();
            }
            Err(format!(
                "Forced engine '{}' is not available for filter='{}' ratio={ratio:.6} (requires taps <= 2048 + integer upsample ratio > 1).",
                engine_override.as_str(),
                normalized_filter_id
            ))
        }
        OversamplingEngineOverride::RubatoSinc => build_rubato(),
    }
}

fn resolve_fft_ola_chunk_frames(profile: HqResamplerProfile, ratio: f64) -> usize {
    let default_frames = hq_resampler_chunk_frames(profile, ratio).max(256);
    let Ok(raw) = std::env::var("AONSOKU_FFT_OLA_CHUNK_FRAMES") else {
        return default_frames;
    };
    let parsed = raw.trim().parse::<usize>().ok();
    let Some(frames) = parsed else {
        return default_frames;
    };
    // Keep memory/latency sane while enabling boundary diagnostics.
    frames.clamp(128, 65_536)
}
