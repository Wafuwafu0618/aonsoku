use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;
use std::f64::consts::PI;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub enum WindowFunction {
    BlackmanHarris,
    Gaussian { sigma: f64 },
}

#[derive(Debug, Clone)]
pub struct FilterSpec {
    pub num_taps: usize,
    pub cutoff: f64,
    pub oversampling_factor: usize,
    pub window: WindowFunction,
    /// Positive values shift the prototype center toward causal (newer) samples.
    /// 0.0 keeps the classic symmetric/linear baseline.
    pub phase_shift_samples: f64,
    /// 0.0 = pure linear-phase FIR, 1.0 = pure minimum-phase approximation.
    pub phase_blend: f64,
}

#[derive(Debug, Clone)]
pub struct SharedPolyphaseCoefficients {
    pub data: Arc<[f32]>,
    pub oversampling_factor: usize,
    pub num_taps: usize,
}

impl SharedPolyphaseCoefficients {
    pub fn phase(&self, phase_index: usize) -> Option<&[f32]> {
        if phase_index >= self.oversampling_factor {
            return None;
        }
        let start = phase_index.saturating_mul(self.num_taps);
        let end = start.saturating_add(self.num_taps).min(self.data.len());
        self.data.get(start..end)
    }
}

pub fn canonical_filter_id(filter_id: Option<&str>) -> &'static str {
    let normalized = filter_id
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    match normalized.as_str() {
        "" | "none" | "off" | "bypass" => "bypass",

        "fir-lp" => "fir-lp",
        "fir-mp" => "fir-mp",
        "fir-asym" => "fir-asym",
        "fir-minring-lp" => "fir-minring-lp",
        "fir-minring-mp" => "fir-minring-mp",
        "fft" => "fft",

        "sinc-s-mp" | "poly-sinc-short-mp" | "poly-sinc-shrt-mp" => "sinc-s-mp",
        "sinc-m-mp" | "poly-sinc-mp" => "sinc-m-mp",
        "sinc-m-lp" | "poly-sinc-lp" => "sinc-m-lp",

        "sinc-l-lp" | "poly-sinc-long-lp" => "sinc-l-lp",
        "sinc-l-mp" | "poly-sinc-long-mp" => "sinc-l-mp",
        "sinc-l-ip" | "poly-sinc-long-ip" => "sinc-l-ip",

        "sinc-m-lp-ext" | "poly-sinc-ext" => "sinc-m-lp-ext",
        "sinc-m-lp-ext2" | "poly-sinc-ext2" => "sinc-m-lp-ext2",

        "sinc-xl-lp" | "poly-sinc-xtr-lp" => "sinc-xl-lp",
        "sinc-xl-mp" | "poly-sinc-xtr-mp" => "sinc-xl-mp",

        "sinc-m-gauss" | "poly-sinc-gauss" => "sinc-m-gauss",
        "sinc-l-gauss" | "poly-sinc-gauss-long" => "sinc-l-gauss",
        "sinc-xl-gauss" | "poly-sinc-gauss-xl" => "sinc-xl-gauss",
        "sinc-xl-gauss-apod" | "poly-sinc-gauss-xla" => "sinc-xl-gauss-apod",

        "sinc-hires-lp" | "poly-sinc-gauss-hires-lp" => "sinc-hires-lp",
        "sinc-hires-mp" | "poly-sinc-gauss-hires-mp" => "sinc-hires-mp",

        "sinc-hb" | "poly-sinc-hb" => "sinc-hb",
        "sinc-hb-l" | "poly-sinc-hb-l" => "sinc-hb-l",

        "sinc-mega" | "sinc-m" | "poly-sinc-ext3" => "sinc-mega",
        "sinc-mega-apod" | "sinc-m-apod" => "sinc-mega-apod",
        "sinc-ultra" | "sinc-l" => "sinc-ultra",
        "sinc-ultra-apod" | "sinc-l-apod" => "sinc-ultra-apod",

        "iir" => "iir",
        "poly-1" | "polynomial-1" => "poly-1",
        "poly-2" | "polynomial-2" => "poly-2",

        _ => "sinc-m-mp",
    }
}

impl FilterSpec {
    pub fn from_filter_id(filter_id: &str, ratio: f64) -> Self {
        let canonical = canonical_filter_id(Some(filter_id));
        let ratio = if ratio.is_finite() && ratio > 0.0 {
            ratio
        } else {
            1.0
        };

        let window = match canonical {
            "sinc-m-gauss" => WindowFunction::Gaussian { sigma: 0.45 },
            "sinc-l-gauss" => WindowFunction::Gaussian { sigma: 0.40 },
            "sinc-xl-gauss" => WindowFunction::Gaussian { sigma: 0.35 },
            "sinc-xl-gauss-apod" => WindowFunction::Gaussian { sigma: 0.32 },
            "sinc-hires-lp" | "sinc-hires-mp" => WindowFunction::Gaussian { sigma: 0.33 },
            _ => WindowFunction::BlackmanHarris,
        };

        let (num_taps, cutoff, oversampling_factor) = profile_triplet(canonical, ratio);
        let phase_shift_samples = match canonical {
            "sinc-mega-apod" | "sinc-ultra-apod" => 0.0,
            _ => 0.0,
        };
        let phase_blend = match canonical {
            "sinc-mega-apod" => 0.10,
            "sinc-ultra-apod" => 0.12,
            _ => 0.0,
        };
        Self {
            num_taps,
            cutoff,
            oversampling_factor,
            window,
            phase_shift_samples,
            phase_blend,
        }
    }

    pub fn compute_polyphase_coefficients(&self) -> Vec<Vec<f32>> {
        let num_taps = self.num_taps.max(1);
        let phases = self.oversampling_factor.max(1);
        let cutoff = self.cutoff.clamp(1.0e-6, 0.999_999);
        let total_taps = num_taps.saturating_mul(phases).max(1);
        let base_center = (total_taps as f64 - 1.0) * 0.5;
        let max_shift = (num_taps as f64 * 0.35).max(0.0);
        let shift_samples = self.phase_shift_samples.clamp(-max_shift, max_shift);
        let prototype_center = base_center - shift_samples * phases as f64;
        let mut prototype = vec![0.0_f32; total_taps];
        for (prototype_index, value) in prototype.iter_mut().enumerate() {
            let sample_index = (prototype_index as f64 - prototype_center) / phases as f64;
            let sinc = normalized_sinc(2.0 * cutoff * sample_index);
            let window = self.window_value(prototype_index, total_taps);
            *value = (2.0 * cutoff * sinc * window) as f32;
        }

        if self.phase_blend > 0.0 {
            let mut planner = FftPlanner::<f32>::new();
            apply_minimum_phase_blend(&mut prototype, self.phase_blend, &mut planner);
        }

        let mut matrix = Vec::with_capacity(phases);

        for phase in 0..phases {
            let mut coefficients = vec![0.0_f32; num_taps];
            let mut sum = 0.0_f64;

            for (index, coefficient) in coefficients.iter_mut().enumerate() {
                let prototype_index = index.saturating_mul(phases).saturating_add(phase);
                let value = prototype.get(prototype_index).copied().unwrap_or(0.0) as f64;
                *coefficient = value as f32;
                sum += value;
            }

            if sum.abs() > 1.0e-12 {
                for coefficient in &mut coefficients {
                    *coefficient = (*coefficient as f64 / sum) as f32;
                }
            }
            matrix.push(coefficients);
        }

        matrix
    }

    pub fn compute_polyphase_coefficients_shared(&self) -> SharedPolyphaseCoefficients {
        let matrix = self.compute_polyphase_coefficients();
        let oversampling_factor = matrix.len();
        let num_taps = matrix.first().map(|phase| phase.len()).unwrap_or(0);
        let mut flattened = Vec::with_capacity(oversampling_factor.saturating_mul(num_taps));
        for phase in matrix {
            flattened.extend_from_slice(&phase);
        }

        SharedPolyphaseCoefficients {
            data: Arc::<[f32]>::from(flattened),
            oversampling_factor,
            num_taps,
        }
    }

    fn window_value(&self, index: usize, num_taps: usize) -> f64 {
        if num_taps <= 1 {
            return 1.0;
        }

        match self.window {
            WindowFunction::BlackmanHarris => {
                let phase = 2.0 * PI * index as f64 / (num_taps as f64 - 1.0);
                let a0 = 0.358_75_f64;
                let a1 = 0.488_29_f64;
                let a2 = 0.141_28_f64;
                let a3 = 0.011_68_f64;
                a0 - a1 * phase.cos() + a2 * (2.0 * phase).cos() - a3 * (3.0 * phase).cos()
            }
            WindowFunction::Gaussian { sigma } => {
                let sigma = sigma.clamp(0.05, 1.0);
                let center = (num_taps as f64 - 1.0) * 0.5;
                let radius = center.max(1.0);
                let x = (index as f64 - center) / (sigma * radius);
                (-0.5 * x * x).exp()
            }
        }
    }
}

fn normalized_sinc(x: f64) -> f64 {
    if x.abs() < 1.0e-12 {
        1.0
    } else {
        (PI * x).sin() / (PI * x)
    }
}

fn apply_minimum_phase_blend(
    coefficients: &mut [f32],
    blend: f64,
    planner: &mut FftPlanner<f32>,
) {
    let blend = blend.clamp(0.0, 1.0);
    if blend <= 0.0 || coefficients.len() < 8 {
        return;
    }

    let minimum_phase = minimum_phase_from_fir(coefficients, planner);
    if minimum_phase.len() != coefficients.len() {
        return;
    }

    let keep = (1.0 - blend) as f32;
    let mix = blend as f32;
    for (value, minimum) in coefficients.iter_mut().zip(minimum_phase.iter()) {
        *value = *value * keep + *minimum * mix;
    }

    let sum: f32 = coefficients.iter().copied().sum();
    if sum.abs() > 1.0e-12 {
        for value in coefficients {
            *value /= sum;
        }
    }
}

fn minimum_phase_from_fir(coefficients: &[f32], planner: &mut FftPlanner<f32>) -> Vec<f32> {
    let taps = coefficients.len();
    if taps == 0 {
        return Vec::new();
    }

    let fft_len = taps.saturating_mul(8).next_power_of_two().max(256);
    let mut linear_spectrum = vec![Complex32::new(0.0, 0.0); fft_len];
    for (index, value) in coefficients.iter().copied().enumerate() {
        linear_spectrum[index].re = value;
    }

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

fn profile_triplet(filter_id: &str, ratio: f64) -> (usize, f64, usize) {
    match filter_id {
        "bypass" => (1, 0.999, 1),

        "sinc-s-mp" => {
            if ratio >= 8.0 {
                (18, 0.885, 4)
            } else if ratio >= 4.0 {
                (20, 0.890, 5)
            } else {
                (24, 0.900, 6)
            }
        }
        "sinc-m-mp" => {
            if ratio >= 8.0 {
                (32, 0.915, 6)
            } else if ratio >= 4.0 {
                (36, 0.925, 7)
            } else {
                (44, 0.935, 8)
            }
        }
        "sinc-m-lp" => {
            if ratio >= 8.0 {
                (56, 0.945, 8)
            } else if ratio >= 4.0 {
                (72, 0.952, 10)
            } else {
                (88, 0.958, 12)
            }
        }
        "sinc-l-lp" => {
            if ratio >= 8.0 {
                (512, 0.968, 64)
            } else if ratio >= 4.0 {
                (256, 0.968, 32)
            } else {
                (192, 0.968, 20)
            }
        }
        "sinc-l-mp" => {
            if ratio >= 8.0 {
                (448, 0.966, 56)
            } else if ratio >= 4.0 {
                (224, 0.966, 28)
            } else {
                (168, 0.966, 18)
            }
        }
        "sinc-l-ip" => {
            if ratio >= 8.0 {
                (480, 0.967, 60)
            } else if ratio >= 4.0 {
                (240, 0.967, 30)
            } else {
                (176, 0.967, 19)
            }
        }
        "sinc-m-lp-ext" => {
            if ratio >= 8.0 {
                (72, 0.958, 10)
            } else if ratio >= 4.0 {
                (88, 0.963, 12)
            } else {
                (104, 0.968, 14)
            }
        }
        "sinc-m-lp-ext2" => {
            if ratio >= 8.0 {
                (112, 0.966, 14)
            } else if ratio >= 4.0 {
                (144, 0.970, 18)
            } else {
                (176, 0.974, 20)
            }
        }
        "sinc-xl-lp" => {
            if ratio >= 8.0 {
                (1024, 0.972, 96)
            } else if ratio >= 4.0 {
                (768, 0.972, 64)
            } else {
                (512, 0.972, 40)
            }
        }
        "sinc-xl-mp" => {
            if ratio >= 8.0 {
                (896, 0.970, 88)
            } else if ratio >= 4.0 {
                (640, 0.970, 56)
            } else {
                (448, 0.970, 36)
            }
        }
        "sinc-m-gauss" => {
            if ratio >= 8.0 {
                (64, 0.948, 8)
            } else if ratio >= 4.0 {
                (80, 0.954, 10)
            } else {
                (96, 0.960, 12)
            }
        }
        "sinc-l-gauss" => {
            if ratio >= 8.0 {
                (640, 0.970, 72)
            } else if ratio >= 4.0 {
                (384, 0.970, 40)
            } else {
                (256, 0.970, 24)
            }
        }
        "sinc-xl-gauss" => {
            if ratio >= 8.0 {
                (1280, 0.973, 112)
            } else if ratio >= 4.0 {
                (896, 0.973, 72)
            } else {
                (640, 0.973, 48)
            }
        }
        "sinc-xl-gauss-apod" => {
            if ratio >= 8.0 {
                (1280, 0.965, 112)
            } else if ratio >= 4.0 {
                (896, 0.965, 72)
            } else {
                (640, 0.965, 48)
            }
        }
        "sinc-hires-lp" => {
            if ratio >= 8.0 {
                (768, 0.975, 80)
            } else if ratio >= 4.0 {
                (512, 0.975, 52)
            } else {
                (384, 0.975, 32)
            }
        }
        "sinc-hires-mp" => {
            if ratio >= 8.0 {
                (704, 0.973, 72)
            } else if ratio >= 4.0 {
                (448, 0.973, 48)
            } else {
                (320, 0.973, 28)
            }
        }
        "sinc-hb" => {
            if ratio >= 8.0 {
                (96, 0.955, 10)
            } else if ratio >= 4.0 {
                (128, 0.960, 12)
            } else {
                (160, 0.965, 14)
            }
        }
        "sinc-hb-l" => {
            if ratio >= 8.0 {
                (512, 0.968, 48)
            } else if ratio >= 4.0 {
                (384, 0.968, 32)
            } else {
                (256, 0.968, 20)
            }
        }
        "sinc-mega" => {
            if ratio >= 8.0 {
                (2048, 0.974, 128)
            } else if ratio >= 4.0 {
                (1536, 0.974, 96)
            } else {
                (1024, 0.974, 64)
            }
        }
        "sinc-mega-apod" => {
            if ratio >= 8.0 {
                (2048, 0.974, 128)
            } else if ratio >= 4.0 {
                (1536, 0.974, 96)
            } else {
                (1024, 0.974, 64)
            }
        }
        "sinc-ultra" => {
            if ratio >= 8.0 {
                (4096, 0.976, 192)
            } else if ratio >= 4.0 {
                (3072, 0.976, 128)
            } else {
                (2048, 0.976, 96)
            }
        }
        "sinc-ultra-apod" => {
            if ratio >= 8.0 {
                (4096, 0.976, 192)
            } else if ratio >= 4.0 {
                (3072, 0.976, 128)
            } else {
                (2048, 0.976, 96)
            }
        }

        "fir-lp" => {
            if ratio >= 8.0 {
                (56, 0.945, 8)
            } else if ratio >= 4.0 {
                (72, 0.952, 10)
            } else {
                (88, 0.958, 12)
            }
        }
        "fir-mp" => {
            if ratio >= 8.0 {
                (48, 0.930, 8)
            } else if ratio >= 4.0 {
                (56, 0.938, 9)
            } else {
                (64, 0.944, 10)
            }
        }
        "fir-asym" => {
            if ratio >= 8.0 {
                (56, 0.936, 8)
            } else if ratio >= 4.0 {
                (64, 0.944, 10)
            } else {
                (72, 0.950, 12)
            }
        }
        "fir-minring-lp" => {
            if ratio >= 8.0 {
                (80, 0.950, 10)
            } else if ratio >= 4.0 {
                (96, 0.956, 12)
            } else {
                (112, 0.962, 14)
            }
        }
        "fir-minring-mp" => {
            if ratio >= 8.0 {
                (72, 0.944, 10)
            } else if ratio >= 4.0 {
                (88, 0.952, 12)
            } else {
                (104, 0.958, 14)
            }
        }
        "fft" => {
            if ratio >= 8.0 {
                (640, 0.980, 80)
            } else if ratio >= 4.0 {
                (512, 0.980, 64)
            } else {
                (384, 0.980, 48)
            }
        }

        "iir" => {
            if ratio >= 8.0 {
                (12, 0.860, 4)
            } else if ratio >= 4.0 {
                (14, 0.875, 4)
            } else {
                (16, 0.890, 4)
            }
        }
        "poly-1" => {
            if ratio >= 8.0 {
                (8, 0.800, 2)
            } else if ratio >= 4.0 {
                (10, 0.820, 2)
            } else {
                (12, 0.840, 2)
            }
        }
        "poly-2" => {
            if ratio >= 8.0 {
                (12, 0.840, 3)
            } else if ratio >= 4.0 {
                (14, 0.860, 3)
            } else {
                (16, 0.880, 3)
            }
        }

        _ => {
            if ratio >= 8.0 {
                (32, 0.915, 6)
            } else if ratio >= 4.0 {
                (36, 0.925, 7)
            } else {
                (44, 0.935, 8)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{canonical_filter_id, FilterSpec, WindowFunction};

    #[test]
    fn canonical_filter_id_maps_legacy_aliases() {
        assert_eq!(canonical_filter_id(Some("poly-sinc-mp")), "sinc-m-mp");
        assert_eq!(canonical_filter_id(Some("poly-sinc-long-lp")), "sinc-l-lp");
        assert_eq!(canonical_filter_id(Some("poly-sinc-ext2")), "sinc-m-lp-ext2");
        assert_eq!(canonical_filter_id(Some("sinc-m-apod")), "sinc-mega-apod");
        assert_eq!(canonical_filter_id(Some("sinc-l-apod")), "sinc-ultra-apod");
    }

    #[test]
    fn from_filter_id_uses_phase2_table() {
        let short_spec = FilterSpec::from_filter_id("sinc-s-mp", 8.0);
        assert_eq!(short_spec.num_taps, 18);
        assert_eq!(short_spec.oversampling_factor, 4);

        let mp_spec = FilterSpec::from_filter_id("sinc-m-mp", 4.0);
        assert_eq!(mp_spec.num_taps, 36);
        assert_eq!(mp_spec.oversampling_factor, 7);

        let lp_spec = FilterSpec::from_filter_id("sinc-m-lp", 2.0);
        assert_eq!(lp_spec.num_taps, 88);
        assert_eq!(lp_spec.oversampling_factor, 12);

        let long_spec = FilterSpec::from_filter_id("sinc-l-lp", 8.0);
        assert_eq!(long_spec.num_taps, 512);
        assert_eq!(long_spec.oversampling_factor, 64);
    }

    #[test]
    fn from_filter_id_supports_new_long_presets() {
        let mega = FilterSpec::from_filter_id("sinc-mega", 8.0);
        assert_eq!(mega.num_taps, 2048);
        assert_eq!(mega.oversampling_factor, 128);

        let ultra = FilterSpec::from_filter_id("sinc-ultra", 4.0);
        assert_eq!(ultra.num_taps, 3072);
        assert_eq!(ultra.oversampling_factor, 128);

        let mega_apod = FilterSpec::from_filter_id("sinc-mega-apod", 8.0);
        assert_eq!(mega_apod.num_taps, 2048);
        assert_eq!(mega_apod.oversampling_factor, 128);
        assert_eq!(mega_apod.window, WindowFunction::BlackmanHarris);
        assert_eq!(mega_apod.phase_shift_samples, 0.0);
        assert!(mega_apod.phase_blend > 0.0);

        let ultra_apod = FilterSpec::from_filter_id("sinc-ultra-apod", 4.0);
        assert_eq!(ultra_apod.num_taps, 3072);
        assert_eq!(ultra_apod.oversampling_factor, 128);
        assert_eq!(ultra_apod.window, WindowFunction::BlackmanHarris);
        assert_eq!(ultra_apod.phase_shift_samples, 0.0);
        assert!(ultra_apod.phase_blend > mega_apod.phase_blend);
    }

    #[test]
    fn from_filter_id_defaults_to_medium_mp() {
        let default_spec = FilterSpec::from_filter_id("unknown-filter", 3.0);
        assert_eq!(default_spec.num_taps, 44);
        assert_eq!(default_spec.oversampling_factor, 8);
        assert_eq!(default_spec.window, WindowFunction::BlackmanHarris);
        assert_eq!(default_spec.phase_shift_samples, 0.0);
        assert_eq!(default_spec.phase_blend, 0.0);
    }

    #[test]
    fn computes_expected_polyphase_shape() {
        let spec = FilterSpec {
            num_taps: 36,
            cutoff: 0.925,
            oversampling_factor: 7,
            window: WindowFunction::BlackmanHarris,
            phase_shift_samples: 0.0,
            phase_blend: 0.0,
        };
        let coefficients = spec.compute_polyphase_coefficients();
        assert_eq!(coefficients.len(), 7);
        assert!(coefficients.iter().all(|phase| phase.len() == 36));
    }

    #[test]
    fn normalizes_each_phase_to_unity_gain() {
        let spec = FilterSpec::from_filter_id("sinc-m-lp", 4.0);
        let coefficients = spec.compute_polyphase_coefficients();
        for phase in coefficients {
            let sum: f64 = phase.iter().map(|value| *value as f64).sum();
            assert!((sum - 1.0).abs() < 5.0e-4, "phase sum out of range: {sum}");
        }
    }

    #[test]
    fn shared_coefficients_keep_phase_layout() {
        let spec = FilterSpec::from_filter_id("sinc-m-mp", 4.0);
        let shared = spec.compute_polyphase_coefficients_shared();
        assert_eq!(shared.oversampling_factor, 7);
        assert_eq!(shared.num_taps, 36);
        assert_eq!(shared.data.len(), 7 * 36);
        let first_phase = shared.phase(0).expect("phase 0 must exist");
        assert_eq!(first_phase.len(), 36);
        assert!(shared.phase(999).is_none());
    }
}
