use serde::Deserialize;
use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CrossfeedPreset {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossfeedConfig {
    pub preset: CrossfeedPreset,
}

impl CrossfeedConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct CrossfeedProfile {
    amount: f32,
    direct_gain: f32,
    output_trim_linear: f32,
    delay_samples: usize,
    cross_kernel: Vec<f32>,
}

impl CrossfeedProfile {
    fn from_preset(preset: CrossfeedPreset, sample_rate_hz: u32) -> Self {
        let (amount, direct_gain, output_trim_db, delay_seconds, cutoff_hz, taps) = match preset {
            CrossfeedPreset::Low => (0.09, 0.99, -0.35, 0.000_16, 650.0, 21),
            CrossfeedPreset::Medium => (0.14, 0.98, -0.65, 0.000_20, 700.0, 25),
            CrossfeedPreset::High => (0.20, 0.96, -1.00, 0.000_24, 760.0, 29),
        };

        let delay_samples_float =
            (delay_seconds * sample_rate_hz as f64).max(0.0) as f32;
        let delay_samples = delay_samples_float.floor() as usize;
        let delay_fraction = (delay_samples_float - delay_samples as f32).clamp(0.0, 0.999_999);

        let base_kernel = create_windowed_sinc_lowpass(
            taps.max(3) | 1,
            cutoff_hz,
            sample_rate_hz.max(1),
        );
        let cross_kernel =
            apply_fractional_delay_kernel(&base_kernel, delay_fraction);

        Self {
            amount,
            direct_gain,
            output_trim_linear: db_to_linear(output_trim_db),
            delay_samples,
            cross_kernel,
        }
    }
}

pub struct CrossfeedProcessor {
    profile: CrossfeedProfile,
    history_l: Vec<f32>,
    history_r: Vec<f32>,
    write_index: usize,
}

impl CrossfeedProcessor {
    pub fn new(config: &CrossfeedConfig, sample_rate_hz: u32) -> Option<Self> {
        if sample_rate_hz == 0 {
            return None;
        }

        let profile = CrossfeedProfile::from_preset(config.preset, sample_rate_hz);
        let history_len = profile
            .delay_samples
            .saturating_add(profile.cross_kernel.len())
            .saturating_add(2)
            .max(8);

        Some(Self {
            profile,
            history_l: vec![0.0; history_len],
            history_r: vec![0.0; history_len],
            write_index: 0,
        })
    }

    pub fn process_stereo_frame(&mut self, left: f32, right: f32) -> (f32, f32) {
        self.history_l[self.write_index] = left;
        self.history_r[self.write_index] = right;

        let cross_to_left = self.cross_from_history(&self.history_r);
        let cross_to_right = self.cross_from_history(&self.history_l);

        let mixed_left =
            self.profile.direct_gain * left + self.profile.amount * cross_to_left;
        let mixed_right =
            self.profile.direct_gain * right + self.profile.amount * cross_to_right;

        self.write_index = (self.write_index + 1) % self.history_l.len();

        (
            mixed_left * self.profile.output_trim_linear,
            mixed_right * self.profile.output_trim_linear,
        )
    }

    fn cross_from_history(&self, history: &[f32]) -> f32 {
        let len = history.len();
        let mut acc = 0.0_f32;
        for (tap_index, coeff) in self.profile.cross_kernel.iter().enumerate() {
            let distance = self
                .profile
                .delay_samples
                .saturating_add(tap_index);
            let idx = (self.write_index + len - (distance % len)) % len;
            acc += coeff * history[idx];
        }
        acc
    }
}

fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

fn sinc(x: f32) -> f32 {
    if x.abs() <= f32::EPSILON {
        return 1.0;
    }
    let px = std::f32::consts::PI * x;
    px.sin() / px
}

fn create_windowed_sinc_lowpass(taps: usize, cutoff_hz: f32, sample_rate_hz: u32) -> Vec<f32> {
    let taps = taps.max(3) | 1;
    let sr = sample_rate_hz as f32;
    let normalized = (cutoff_hz / sr).clamp(1.0e-4, 0.49);
    let center = (taps - 1) as f32 * 0.5;
    let mut kernel = vec![0.0_f32; taps];
    let mut sum = 0.0_f32;

    for (i, slot) in kernel.iter_mut().enumerate() {
        let n = i as f32 - center;
        let blackman =
            0.42
                - 0.5 * ((2.0 * std::f32::consts::PI * i as f32) / (taps as f32 - 1.0)).cos()
                + 0.08 * ((4.0 * std::f32::consts::PI * i as f32) / (taps as f32 - 1.0)).cos();
        let value = 2.0 * normalized * sinc(2.0 * normalized * n) * blackman;
        *slot = value;
        sum += value;
    }

    if sum.abs() > f32::EPSILON {
        for value in &mut kernel {
            *value /= sum;
        }
    }

    let minimum_phase = minimum_phase_from_fir(&kernel);
    if minimum_phase.len() == kernel.len() {
        kernel = minimum_phase;
        let minimum_sum: f32 = kernel.iter().copied().sum();
        if minimum_sum.abs() > 1.0e-12 {
            for value in &mut kernel {
                *value /= minimum_sum;
            }
        }
    }

    kernel
}

fn apply_fractional_delay_kernel(base_kernel: &[f32], fraction: f32) -> Vec<f32> {
    if base_kernel.is_empty() {
        return Vec::new();
    }

    let frac = fraction.clamp(0.0, 1.0 - 1.0e-6);
    if frac <= 1.0e-6 {
        return base_kernel.to_vec();
    }

    // FIR-domain fractional delay synthesis.
    // This is equivalent to linear interpolation between adjacent delayed samples.
    let interpolation_kernel = [1.0_f32 - frac, frac];
    let mut combined =
        vec![0.0_f32; base_kernel.len() + interpolation_kernel.len() - 1];

    for (i, &base) in base_kernel.iter().enumerate() {
        for (j, &interp) in interpolation_kernel.iter().enumerate() {
            combined[i + j] += base * interp;
        }
    }

    let sum: f32 = combined.iter().copied().sum();
    if sum.abs() > 1.0e-12 {
        for value in &mut combined {
            *value /= sum;
        }
    }

    combined
}

fn minimum_phase_from_fir(coefficients: &[f32]) -> Vec<f32> {
    let taps = coefficients.len();
    if taps == 0 {
        return Vec::new();
    }

    let fft_len = taps.saturating_mul(8).next_power_of_two().max(256);
    let mut linear_spectrum = vec![Complex32::new(0.0, 0.0); fft_len];
    for (index, value) in coefficients.iter().copied().enumerate() {
        linear_spectrum[index].re = value;
    }

    let mut planner = FftPlanner::<f32>::new();
    let fft_forward = planner.plan_fft_forward(fft_len);
    let fft_inverse = planner.plan_fft_inverse(fft_len);
    fft_forward.process(&mut linear_spectrum);

    let epsilon = 1.0e-12_f32;
    let mut cepstrum = vec![Complex32::new(0.0, 0.0); fft_len];
    for (dest, bin) in cepstrum.iter_mut().zip(linear_spectrum.iter()) {
        *dest = Complex32::new(bin.norm().max(epsilon).ln(), 0.0);
    }
    fft_inverse.process(&mut cepstrum);
    let inverse_scale = 1.0_f32 / fft_len as f32;
    for value in &mut cepstrum {
        *value *= inverse_scale;
    }

    let mut minimum_cepstrum = vec![Complex32::new(0.0, 0.0); fft_len];
    minimum_cepstrum[0].re = cepstrum[0].re;
    let half = fft_len / 2;
    for index in 1..half {
        minimum_cepstrum[index].re = 2.0 * cepstrum[index].re;
    }
    if fft_len % 2 == 0 {
        minimum_cepstrum[half].re = cepstrum[half].re;
    }

    fft_forward.process(&mut minimum_cepstrum);
    for value in &mut minimum_cepstrum {
        let exp_real = value.re.exp();
        let (sin_imag, cos_imag) = value.im.sin_cos();
        *value = Complex32::new(exp_real * cos_imag, exp_real * sin_imag);
    }
    fft_inverse.process(&mut minimum_cepstrum);
    for value in &mut minimum_cepstrum {
        *value *= inverse_scale;
    }

    minimum_cepstrum
        .iter()
        .take(taps)
        .map(|value| value.re)
        .collect()
}
