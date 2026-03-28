use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnalogColorPreset {
    Light,
    Standard,
    Strong,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalogColorConfig {
    pub preset: AnalogColorPreset,
}

impl AnalogColorConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
struct AnalogColorProfile {
    low_drive_linear: f32,
    low_bias: f32,
    low_mix: f32,
    low_makeup_linear: f32,
    mid_drive_linear: f32,
    mid_bias: f32,
    mid_mix: f32,
    mid_makeup_linear: f32,
    output_trim_linear: f32,
    lowpass_alpha_low: f32,
    lowpass_alpha_mid: f32,
    dc_block_r: f32,
}

impl AnalogColorProfile {
    fn from_preset(preset: AnalogColorPreset, sample_rate_hz: u32) -> Self {
        let (
            low_drive_db,
            low_bias,
            low_mix,
            low_makeup_db,
            mid_drive_db,
            mid_bias,
            mid_mix,
            mid_makeup_db,
            output_trim_db,
            low_band_cutoff_hz,
            mid_band_cutoff_hz,
        ): (f32, f32, f32, f32, f32, f32, f32, f32, f32, f32, f32) = match preset {
            // Mid band is intentionally lighter than low band to keep analog texture without
            // blurring articulation.
            AnalogColorPreset::Light => {
                (4.0, 0.10, 0.30, 0.25, 1.8, 0.05, 0.12, 0.06, -0.8, 180.0, 1_400.0)
            }
            // Compensation-oriented tuning: recover perceived low loss without extra bass boost.
            AnalogColorPreset::Standard => {
                (6.0, 0.15, 0.45, 0.45, 2.6, 0.08, 0.18, 0.12, -1.3, 220.0, 1_700.0)
            }
            AnalogColorPreset::Strong => {
                (8.5, 0.22, 0.62, 0.55, 3.8, 0.11, 0.25, 0.18, -2.3, 280.0, 2_200.0)
            }
        };
        let safe_mid_band_cutoff_hz =
            mid_band_cutoff_hz.max(low_band_cutoff_hz + 120.0_f32);

        Self {
            low_drive_linear: db_to_linear(low_drive_db),
            low_bias,
            low_mix,
            low_makeup_linear: db_to_linear(low_makeup_db),
            mid_drive_linear: db_to_linear(mid_drive_db),
            mid_bias,
            mid_mix,
            mid_makeup_linear: db_to_linear(mid_makeup_db),
            output_trim_linear: db_to_linear(output_trim_db),
            lowpass_alpha_low: one_pole_lowpass_alpha(sample_rate_hz, low_band_cutoff_hz),
            lowpass_alpha_mid: one_pole_lowpass_alpha(sample_rate_hz, safe_mid_band_cutoff_hz),
            dc_block_r: one_pole_highpass_r(sample_rate_hz, 8.0),
        }
    }
}

pub struct AnalogColorProcessor {
    channels: usize,
    profile: AnalogColorProfile,
    low_band_state: Vec<f32>,
    mid_band_state: Vec<f32>,
    low_dc_prev_input: Vec<f32>,
    low_dc_prev_output: Vec<f32>,
    mid_dc_prev_input: Vec<f32>,
    mid_dc_prev_output: Vec<f32>,
}

impl AnalogColorProcessor {
    pub fn new(
        config: &AnalogColorConfig,
        channels: usize,
        sample_rate_hz: u32,
    ) -> Option<Self> {
        if channels == 0 || sample_rate_hz == 0 {
            return None;
        }

        let profile = AnalogColorProfile::from_preset(config.preset, sample_rate_hz);
        Some(Self {
            channels,
            profile,
            low_band_state: vec![0.0; channels],
            mid_band_state: vec![0.0; channels],
            low_dc_prev_input: vec![0.0; channels],
            low_dc_prev_output: vec![0.0; channels],
            mid_dc_prev_input: vec![0.0; channels],
            mid_dc_prev_output: vec![0.0; channels],
        })
    }

    pub fn process_interleaved_in_place(&mut self, samples: &mut [f32]) {
        if self.channels == 0 {
            return;
        }

        for frame in samples.chunks_exact_mut(self.channels) {
            for (channel, sample) in frame.iter_mut().enumerate() {
                let input = *sample;

                let low_lp = self.low_band_state[channel]
                    + self.profile.lowpass_alpha_low * (input - self.low_band_state[channel]);
                self.low_band_state[channel] = low_lp;

                let mid_lp = self.mid_band_state[channel]
                    + self.profile.lowpass_alpha_mid * (input - self.mid_band_state[channel]);
                self.mid_band_state[channel] = mid_lp;

                let low = low_lp;
                let mid = mid_lp - low_lp;
                let high = input - mid_lp;

                let low_colored = process_even_harmonic_band(
                    low,
                    self.profile.low_drive_linear,
                    self.profile.low_bias,
                    self.profile.low_mix,
                    self.profile.low_makeup_linear,
                    self.profile.dc_block_r,
                    &mut self.low_dc_prev_input[channel],
                    &mut self.low_dc_prev_output[channel],
                );

                let mid_colored = process_even_harmonic_band(
                    mid,
                    self.profile.mid_drive_linear,
                    self.profile.mid_bias,
                    self.profile.mid_mix,
                    self.profile.mid_makeup_linear,
                    self.profile.dc_block_r,
                    &mut self.mid_dc_prev_input[channel],
                    &mut self.mid_dc_prev_output[channel],
                );

                *sample =
                    (low_colored + mid_colored + high) * self.profile.output_trim_linear;
            }
        }
    }
}

fn process_even_harmonic_band(
    band_input: f32,
    drive_linear: f32,
    bias: f32,
    mix: f32,
    makeup_linear: f32,
    dc_block_r: f32,
    prev_input: &mut f32,
    prev_output: &mut f32,
) -> f32 {
    let safe_drive = drive_linear.max(1.0e-4);
    let driven = band_input * safe_drive;
    let wet = tube_shaper(driven, bias) / safe_drive;
    let blended = band_input + mix * (wet - band_input);

    let dc_blocked = blended - *prev_input + dc_block_r * *prev_output;
    *prev_input = blended;
    *prev_output = dc_blocked;

    dc_blocked * makeup_linear
}

fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

fn one_pole_lowpass_alpha(sample_rate_hz: u32, cutoff_hz: f32) -> f32 {
    let sample_rate = sample_rate_hz as f32;
    if sample_rate <= 0.0 {
        return 1.0;
    }

    let omega = (2.0 * std::f32::consts::PI * cutoff_hz.max(1.0)) / sample_rate;
    (1.0 - (-omega).exp()).clamp(1.0e-4, 1.0)
}

fn one_pole_highpass_r(sample_rate_hz: u32, cutoff_hz: f32) -> f32 {
    let sample_rate = sample_rate_hz as f32;
    if sample_rate <= 0.0 {
        return 0.995;
    }

    let omega = (2.0 * std::f32::consts::PI * cutoff_hz.max(0.5)) / sample_rate;
    (-omega).exp().clamp(0.0, 0.999_95)
}

fn tube_shaper(input: f32, bias: f32) -> f32 {
    (input + bias).tanh() - bias.tanh()
}
