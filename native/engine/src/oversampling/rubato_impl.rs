use super::filter::OversamplingFilter;
use super::coefficients::{canonical_filter_id, FilterSpec};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

const HQ_RESAMPLER_CHUNK_FRAMES: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HqResamplerProfile {
    ShortMp,
    Mp,
    Lp,
    LongLp,
}

impl HqResamplerProfile {
    pub fn from_filter_id(filter_id: Option<&str>) -> Self {
        match canonical_filter_id(filter_id) {
            "sinc-s-mp" => Self::ShortMp,
            "sinc-l-lp"
            | "sinc-l-mp"
            | "sinc-l-ip"
            | "sinc-xl-lp"
            | "sinc-xl-mp"
            | "sinc-l-gauss"
            | "sinc-xl-gauss"
            | "sinc-xl-gauss-apod"
            | "sinc-hires-lp"
            | "sinc-hires-mp"
            | "sinc-hb-l"
            | "sinc-mega"
            | "sinc-ultra"
            | "fft" => Self::LongLp,
            "sinc-m-lp" | "sinc-m-lp-ext" | "sinc-m-lp-ext2" | "sinc-hb" | "fir-lp"
            | "fir-minring-lp" => Self::Lp,
            _ => Self::Mp,
        }
    }

}

#[derive(Clone, Copy, Debug)]
pub struct RubatoFilterInfo {
    pub engine: &'static str,
    pub filter_id: &'static str,
    pub profile: HqResamplerProfile,
    pub ratio: f64,
    pub sinc_len: usize,
    pub f_cutoff: f32,
    pub oversampling_factor: usize,
    pub input_chunk_frames: usize,
}

pub fn hq_resampler_chunk_frames(profile: HqResamplerProfile, ratio: f64) -> usize {
    match profile {
        HqResamplerProfile::LongLp => {
            if ratio >= 8.0 {
                4096
            } else if ratio >= 4.0 {
                2048
            } else {
                1024
            }
        }
        HqResamplerProfile::Lp => {
            if ratio >= 8.0 {
                2048
            } else {
                1024
            }
        }
        HqResamplerProfile::Mp | HqResamplerProfile::ShortMp => HQ_RESAMPLER_CHUNK_FRAMES,
    }
}

pub fn rubato_filter_info(
    filter_id: &'static str,
    profile: HqResamplerProfile,
    ratio: f64,
) -> RubatoFilterInfo {
    let spec = FilterSpec::from_filter_id(filter_id, ratio);

    RubatoFilterInfo {
        engine: "rubato-sinc",
        filter_id,
        profile,
        ratio,
        sinc_len: spec.num_taps,
        f_cutoff: spec.cutoff as f32,
        oversampling_factor: spec.oversampling_factor,
        input_chunk_frames: hq_resampler_chunk_frames(profile, ratio),
    }
}

fn build_hq_resampler_params(
    filter_id: &'static str,
    profile: HqResamplerProfile,
    ratio: f64,
) -> SincInterpolationParameters {
    let info = rubato_filter_info(filter_id, profile, ratio);
    SincInterpolationParameters {
        sinc_len: info.sinc_len,
        f_cutoff: info.f_cutoff.clamp(0.82, 0.98),
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: info.oversampling_factor.max(4),
        window: WindowFunction::BlackmanHarris2,
    }
}

pub struct RubatoOversamplingFilter {
    filter_id: &'static str,
    channels: usize,
    ratio: f64,
    input_chunk_frames: usize,
    resampler: SincFixedIn<f32>,
    input_planar: Vec<Vec<f32>>,
}

impl RubatoOversamplingFilter {
    pub fn new(
        filter_id: &'static str,
        profile: HqResamplerProfile,
        ratio: f64,
        channels: usize,
    ) -> Result<(Self, RubatoFilterInfo), String> {
        if channels == 0 {
            return Err("Oversampling filter channels must be greater than zero.".to_string());
        }
        if !ratio.is_finite() || ratio <= 0.0 {
            return Err("Oversampling filter ratio must be a positive finite value.".to_string());
        }

        let info = rubato_filter_info(filter_id, profile, ratio);
        let params = build_hq_resampler_params(filter_id, profile, ratio);
        let resampler = SincFixedIn::<f32>::new(
            ratio,
            2.0,
            params,
            info.input_chunk_frames,
            channels,
        )
        .map_err(|error| format!("Failed to initialize HQ resampler: {error}"))?;

        let mut input_planar = Vec::with_capacity(channels);
        for _ in 0..channels {
            input_planar.push(Vec::with_capacity(info.input_chunk_frames));
        }

        Ok((
            Self {
                filter_id,
                channels,
                ratio,
                input_chunk_frames: info.input_chunk_frames,
                resampler,
                input_planar,
            },
            info,
        ))
    }

    fn interleave_planar(planar: &[Vec<f32>], channels: usize, output: &mut Vec<f32>) -> usize {
        if planar.is_empty() || channels == 0 {
            output.clear();
            return 0;
        }

        let frames = planar[0].len();
        output.clear();
        output.reserve(frames.saturating_mul(channels));

        for frame_index in 0..frames {
            for channel in 0..channels {
                let sample = planar
                    .get(channel)
                    .and_then(|channel_samples| channel_samples.get(frame_index))
                    .copied()
                    .unwrap_or(0.0);
                output.push(sample);
            }
        }

        output.len()
    }

    fn deinterleave_input(&mut self, input: &[f32], frames: usize) {
        for channel in 0..self.channels {
            self.input_planar[channel].clear();
            self.input_planar[channel].reserve(frames);
        }

        for frame_index in 0..frames {
            let base = frame_index * self.channels;
            for channel in 0..self.channels {
                self.input_planar[channel].push(input[base + channel]);
            }
        }
    }
}

impl OversamplingFilter for RubatoOversamplingFilter {
    fn filter_id(&self) -> &'static str {
        self.filter_id
    }

    fn ratio(&self) -> f64 {
        self.ratio
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn process_chunk(&mut self, input: &[f32], output: &mut Vec<f32>) -> Result<usize, String> {
        if self.channels == 0 {
            output.clear();
            return Ok(0);
        }

        if input.is_empty() {
            let processed = self
                .resampler
                .process_partial(None::<&[Vec<f32>]>, None)
                .map_err(|error| format!("Failed to flush HQ resampler tail: {error}"))?;
            return Ok(Self::interleave_planar(&processed, self.channels, output));
        }

        if input.len() % self.channels != 0 {
            return Err(format!(
                "Interleaved chunk size {} is not divisible by channel count {}.",
                input.len(), self.channels
            ));
        }

        let frames = input.len() / self.channels;
        if frames > self.input_chunk_frames {
            return Err(format!(
                "Input chunk has {} frames, exceeds configured resampler chunk {} frames.",
                frames, self.input_chunk_frames
            ));
        }

        self.deinterleave_input(input, frames);
        let processed = if frames == self.input_chunk_frames {
            self.resampler
                .process(&self.input_planar, None)
                .map_err(|error| format!("Failed to process HQ resampler chunk: {error}"))?
        } else {
            self.resampler
                .process_partial(Some(&self.input_planar), None)
                .map_err(|error| format!("Failed to process final HQ resampler chunk: {error}"))?
        };

        Ok(Self::interleave_planar(&processed, self.channels, output))
    }

    fn reset(&mut self) {
        self.resampler.reset();
        for channel in &mut self.input_planar {
            channel.clear();
        }
    }

    fn latency_frames(&self) -> usize {
        self.resampler.output_delay()
    }
}
