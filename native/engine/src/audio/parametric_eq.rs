use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum ParametricEqFilterType {
    PK,
    LSC,
    HSC,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParametricEqBand {
    #[serde(default)]
    pub enabled: bool,
    #[serde(rename = "type")]
    pub filter_type: ParametricEqFilterType,
    pub frequency_hz: f32,
    pub gain_db: f32,
    pub q: f32,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParametricEqConfig {
    pub preamp_db: f32,
    #[serde(default)]
    pub bands: Vec<ParametricEqBand>,
}

impl ParametricEqConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !self.preamp_db.is_finite() {
            return Err("parametricEq.preampDb must be a finite number.");
        }

        if self.bands.len() > 64 {
            return Err("parametricEq.bands must contain 64 bands or fewer.");
        }

        for band in &self.bands {
            if !band.frequency_hz.is_finite() || band.frequency_hz <= 0.0 {
                return Err("parametricEq.bands[].frequencyHz must be a finite number > 0.");
            }
            if !band.gain_db.is_finite() {
                return Err("parametricEq.bands[].gainDb must be a finite number.");
            }
            if !band.q.is_finite() || band.q <= 0.0 {
                return Err("parametricEq.bands[].q must be a finite number > 0.");
            }
        }

        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
struct BiquadCoefficients {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

#[derive(Clone, Copy, Debug, Default)]
struct BiquadState {
    z1: f32,
    z2: f32,
}

impl BiquadState {
    fn process(&mut self, coeff: BiquadCoefficients, input: f32) -> f32 {
        let output = coeff.b0.mul_add(input, self.z1);
        self.z1 = coeff.b1.mul_add(input, -coeff.a1 * output + self.z2);
        self.z2 = coeff.b2.mul_add(input, -coeff.a2 * output);
        output
    }
}

#[derive(Debug, Clone)]
struct BandProcessor {
    coeff: BiquadCoefficients,
    states: Vec<BiquadState>,
}

impl BandProcessor {
    fn process_sample(&mut self, channel: usize, input: f32) -> f32 {
        match self.states.get_mut(channel) {
            Some(state) => state.process(self.coeff, input),
            None => input,
        }
    }
}

pub struct ParametricEqProcessor {
    channels: usize,
    preamp_linear: f32,
    bands: Vec<BandProcessor>,
}

impl ParametricEqProcessor {
    pub fn new(
        config: &ParametricEqConfig,
        channels: usize,
        sample_rate_hz: u32,
    ) -> Option<Self> {
        if channels == 0 || sample_rate_hz == 0 {
            return None;
        }

        let preamp_linear = db_to_linear(config.preamp_db);
        let mut bands = Vec::new();

        for band in config.bands.iter().filter(|band| band.enabled) {
            let coeff = make_biquad_coefficients(band, sample_rate_hz);
            bands.push(BandProcessor {
                coeff,
                states: vec![BiquadState::default(); channels],
            });
        }

        if bands.is_empty() && (preamp_linear - 1.0).abs() <= f32::EPSILON {
            return None;
        }

        Some(Self {
            channels,
            preamp_linear,
            bands,
        })
    }

    pub fn process_interleaved_in_place(&mut self, samples: &mut [f32]) {
        if self.channels == 0 {
            return;
        }

        for frame in samples.chunks_exact_mut(self.channels) {
            for (channel, sample) in frame.iter_mut().enumerate() {
                let mut value = *sample * self.preamp_linear;
                for band in &mut self.bands {
                    value = band.process_sample(channel, value);
                }
                *sample = value;
            }
        }
    }
}

fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

fn clamp_frequency(frequency_hz: f32, sample_rate_hz: u32) -> f32 {
    let nyquist = (sample_rate_hz as f32) * 0.5;
    frequency_hz.clamp(10.0, (nyquist * 0.95).max(10.0))
}

fn clamp_q(q: f32) -> f32 {
    q.clamp(0.05, 20.0)
}

fn make_biquad_coefficients(band: &ParametricEqBand, sample_rate_hz: u32) -> BiquadCoefficients {
    let frequency_hz = clamp_frequency(band.frequency_hz, sample_rate_hz);
    let q = clamp_q(band.q);
    let gain_db = band.gain_db.clamp(-24.0, 24.0);

    let omega = (2.0 * std::f32::consts::PI * frequency_hz) / (sample_rate_hz as f32);
    let sin_omega = omega.sin();
    let cos_omega = omega.cos();
    let a = 10.0_f32.powf(gain_db / 40.0);
    let alpha = sin_omega / (2.0 * q);
    let shelf_slope = q.max(0.05);

    let (mut b0, mut b1, mut b2, a0, mut a1, mut a2) = match band.filter_type {
        ParametricEqFilterType::PK => (
            1.0 + alpha * a,
            -2.0 * cos_omega,
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * cos_omega,
            1.0 - alpha / a,
        ),
        ParametricEqFilterType::LSC => {
            let sqrt_a = a.sqrt();
            let term = ((a + 1.0 / a) * (1.0 / shelf_slope - 1.0) + 2.0).max(0.0);
            let alpha_s = (sin_omega / 2.0) * term.sqrt();

            (
                a * ((a + 1.0) - (a - 1.0) * cos_omega + 2.0 * sqrt_a * alpha_s),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cos_omega),
                a * ((a + 1.0) - (a - 1.0) * cos_omega - 2.0 * sqrt_a * alpha_s),
                (a + 1.0) + (a - 1.0) * cos_omega + 2.0 * sqrt_a * alpha_s,
                -2.0 * ((a - 1.0) + (a + 1.0) * cos_omega),
                (a + 1.0) + (a - 1.0) * cos_omega - 2.0 * sqrt_a * alpha_s,
            )
        }
        ParametricEqFilterType::HSC => {
            let sqrt_a = a.sqrt();
            let term = ((a + 1.0 / a) * (1.0 / shelf_slope - 1.0) + 2.0).max(0.0);
            let alpha_s = (sin_omega / 2.0) * term.sqrt();

            (
                a * ((a + 1.0) + (a - 1.0) * cos_omega + 2.0 * sqrt_a * alpha_s),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_omega),
                a * ((a + 1.0) + (a - 1.0) * cos_omega - 2.0 * sqrt_a * alpha_s),
                (a + 1.0) - (a - 1.0) * cos_omega + 2.0 * sqrt_a * alpha_s,
                2.0 * ((a - 1.0) - (a + 1.0) * cos_omega),
                (a + 1.0) - (a - 1.0) * cos_omega - 2.0 * sqrt_a * alpha_s,
            )
        }
    };

    let inv_a0 = if a0.abs() <= f32::EPSILON { 1.0 } else { 1.0 / a0 };
    b0 *= inv_a0;
    b1 *= inv_a0;
    b2 *= inv_a0;
    a1 *= inv_a0;
    a2 *= inv_a0;

    BiquadCoefficients { b0, b1, b2, a1, a2 }
}
