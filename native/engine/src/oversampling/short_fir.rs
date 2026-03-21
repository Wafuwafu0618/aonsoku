use super::coefficients::{FilterSpec, SharedPolyphaseCoefficients};
use super::filter::OversamplingFilter;

pub struct ShortFirOversamplingFilter {
    filter_id: &'static str,
    channels: usize,
    ratio: f64,
    upsample_ratio: usize,
    num_taps: usize,
    coefficients: SharedPolyphaseCoefficients,
    step_coeff_offsets: Vec<usize>,
    delay_lines: Vec<Vec<f32>>,
    delay_write_pos: usize,
    tail_frames_remaining: usize,
    tail_flushed: bool,
    has_seen_input: bool,
    latency_output_frames: usize,
    use_avx2: bool,
}

impl ShortFirOversamplingFilter {
    pub fn new(
        filter_id: &'static str,
        ratio: f64,
        channels: usize,
        spec: FilterSpec,
    ) -> Result<Self, String> {
        if channels == 0 {
            return Err("Short FIR filter channels must be greater than zero.".to_string());
        }
        if !ratio.is_finite() || ratio <= 0.0 {
            return Err("Short FIR filter ratio must be a positive finite value.".to_string());
        }

        let Some(upsample_ratio) = integer_upsample_ratio(ratio) else {
            return Err(format!(
                "Short FIR filter supports integer upsample ratios only (ratio={ratio:.6})."
            ));
        };
        if upsample_ratio <= 1 {
            return Err(format!(
                "Short FIR filter requires ratio > 1.0 for resampling (ratio={ratio:.6})."
            ));
        }

        let num_taps = spec.num_taps.max(1);
        let coefficients = spec.compute_polyphase_coefficients_shared();

        let mut delay_lines = Vec::with_capacity(channels);
        for _ in 0..channels {
            // Mirror storage: [0..num_taps] and [num_taps..2*num_taps] are kept identical.
            // This lets us read a contiguous window from `delay_write_pos` without split handling.
            delay_lines.push(vec![0.0_f32; num_taps.saturating_mul(2)]);
        }

        let phase_offsets = build_phase_offsets(coefficients.oversampling_factor, num_taps);
        let step_coeff_offsets = build_step_coeff_offsets(
            upsample_ratio,
            coefficients.oversampling_factor,
            &phase_offsets,
        );

        let latency_input_frames = (num_taps.saturating_sub(1)) as f64 * 0.5;
        let latency_output_frames = (latency_input_frames * upsample_ratio as f64).round() as usize;

        Ok(Self {
            filter_id,
            channels,
            ratio,
            upsample_ratio,
            num_taps,
            coefficients,
            step_coeff_offsets,
            delay_lines,
            delay_write_pos: 0,
            tail_frames_remaining: num_taps.saturating_sub(1),
            tail_flushed: false,
            has_seen_input: false,
            latency_output_frames,
            use_avx2: detect_avx2(),
        })
    }

    fn push_frame(&mut self, frame: &[f32]) {
        if self.delay_write_pos == 0 {
            self.delay_write_pos = self.num_taps.saturating_sub(1);
        } else {
            self.delay_write_pos -= 1;
        }

        for (channel, sample) in frame.iter().enumerate().take(self.channels) {
            let line = &mut self.delay_lines[channel];
            line[self.delay_write_pos] = *sample;
            line[self.delay_write_pos + self.num_taps] = *sample;
        }
    }

    fn push_zero_frame(&mut self) {
        if self.delay_write_pos == 0 {
            self.delay_write_pos = self.num_taps.saturating_sub(1);
        } else {
            self.delay_write_pos -= 1;
        }

        for channel in 0..self.channels {
            let line = &mut self.delay_lines[channel];
            line[self.delay_write_pos] = 0.0;
            line[self.delay_write_pos + self.num_taps] = 0.0;
        }
    }

    fn render_current_frame(&self, output: &mut [f32], mut output_index: usize) -> usize {
        let tap_start = self.delay_write_pos;
        let tap_end = tap_start + self.num_taps;
        for &coeff_start in &self.step_coeff_offsets {
            let coefficients = &self.coefficients.data[coeff_start..coeff_start + self.num_taps];
            for channel in 0..self.channels {
                let taps = &self.delay_lines[channel][tap_start..tap_end];
                output[output_index] = dot_contiguous(coefficients, taps, self.use_avx2);
                output_index += 1;
            }
        }
        output_index
    }

    fn required_output_samples(&self, input_frames: usize) -> usize {
        input_frames
            .saturating_mul(self.upsample_ratio)
            .saturating_mul(self.channels)
    }
}

impl OversamplingFilter for ShortFirOversamplingFilter {
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
            if !self.has_seen_input {
                output.clear();
                return Ok(0);
            }
            if self.tail_flushed || self.tail_frames_remaining == 0 {
                self.tail_flushed = true;
                self.tail_frames_remaining = 0;
                output.clear();
                return Ok(0);
            }

            let required_samples = self.required_output_samples(self.tail_frames_remaining);
            if output.capacity() < required_samples {
                return Err(format!(
                    "Output buffer capacity {} is below required {} samples for short FIR tail flush.",
                    output.capacity(),
                    required_samples
                ));
            }

            output.clear();
            // SAFETY: `required_samples` is bounded by existing capacity check and every sample
            // is overwritten before returning.
            unsafe { output.set_len(required_samples) };
            let mut output_index = 0usize;
            for _ in 0..self.tail_frames_remaining {
                self.push_zero_frame();
                output_index = self.render_current_frame(output, output_index);
            }
            debug_assert_eq!(output_index, required_samples);

            self.tail_frames_remaining = 0;
            self.tail_flushed = true;
            Ok(output_index)
        } else {
            if input.len() % self.channels != 0 {
                return Err(format!(
                    "Interleaved chunk size {} is not divisible by channel count {}.",
                    input.len(),
                    self.channels
                ));
            }

            let input_frames = input.len() / self.channels;
            let required_samples = self.required_output_samples(input_frames);
            if output.capacity() < required_samples {
                return Err(format!(
                    "Output buffer capacity {} is below required {} samples for short FIR processing.",
                    output.capacity(),
                    required_samples
                ));
            }

            output.clear();
            // SAFETY: `required_samples` is bounded by existing capacity check and every sample
            // is overwritten before returning.
            unsafe { output.set_len(required_samples) };
            let mut output_index = 0usize;

            self.tail_frames_remaining = self.num_taps.saturating_sub(1);
            self.tail_flushed = false;
            self.has_seen_input = true;

            for frame in input.chunks_exact(self.channels) {
                self.push_frame(frame);
                output_index = self.render_current_frame(output, output_index);
            }

            debug_assert_eq!(output_index, required_samples);
            Ok(output_index)
        }
    }

    fn reset(&mut self) {
        for line in &mut self.delay_lines {
            line.fill(0.0);
        }
        self.delay_write_pos = 0;
        self.tail_frames_remaining = self.num_taps.saturating_sub(1);
        self.tail_flushed = false;
        self.has_seen_input = false;
    }

    fn latency_frames(&self) -> usize {
        self.latency_output_frames
    }
}

pub fn integer_upsample_ratio(ratio: f64) -> Option<usize> {
    if !ratio.is_finite() || ratio <= 0.0 {
        return None;
    }
    let rounded = ratio.round();
    if (ratio - rounded).abs() <= 1.0e-6 && rounded >= 1.0 {
        Some(rounded as usize)
    } else {
        None
    }
}

fn build_phase_offsets(oversampling_factor: usize, num_taps: usize) -> Vec<usize> {
    let mut offsets = Vec::with_capacity(oversampling_factor);
    for phase in 0..oversampling_factor {
        offsets.push(phase.saturating_mul(num_taps));
    }
    offsets
}

fn build_step_coeff_offsets(
    upsample_ratio: usize,
    oversampling_factor: usize,
    phase_offsets: &[usize],
) -> Vec<usize> {
    let mut map = Vec::with_capacity(upsample_ratio.max(1));
    if upsample_ratio == 0 || oversampling_factor == 0 {
        map.push(0);
        return map;
    }

    for step in 0..upsample_ratio {
        let position = (step as f64 / upsample_ratio as f64) * oversampling_factor as f64;
        let phase = (position.floor() as usize).min(oversampling_factor.saturating_sub(1));
        map.push(phase_offsets[phase]);
    }

    map
}

fn dot_contiguous(coefficients: &[f32], taps: &[f32], use_avx2: bool) -> f32 {
    let len = coefficients.len().min(taps.len());
    if len == 0 {
        return 0.0;
    }

    #[cfg(target_arch = "x86_64")]
    {
        if use_avx2 {
            // SAFETY: AVX2 availability is checked once at initialization and stored in `use_avx2`.
            return unsafe { dot_contiguous_avx2(&coefficients[..len], &taps[..len]) };
        }
    }

    dot_contiguous_scalar(&coefficients[..len], &taps[..len])
}

fn dot_contiguous_scalar(coefficients: &[f32], taps: &[f32]) -> f32 {
    let len = coefficients.len().min(taps.len());
    let mut acc0 = 0.0_f32;
    let mut acc1 = 0.0_f32;
    let mut acc2 = 0.0_f32;
    let mut acc3 = 0.0_f32;
    let mut index = 0usize;
    while index + 4 <= len {
        acc0 += coefficients[index] * taps[index];
        acc1 += coefficients[index + 1] * taps[index + 1];
        acc2 += coefficients[index + 2] * taps[index + 2];
        acc3 += coefficients[index + 3] * taps[index + 3];
        index += 4;
    }
    let mut acc = acc0 + acc1 + acc2 + acc3;
    while index < len {
        acc += coefficients[index] * taps[index];
        index += 1;
    }
    acc
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn dot_contiguous_avx2(coefficients: &[f32], taps: &[f32]) -> f32 {
    use std::arch::x86_64::{
        _mm256_add_ps, _mm256_loadu_ps, _mm256_mul_ps, _mm256_setzero_ps, _mm256_storeu_ps,
    };

    let len = coefficients.len().min(taps.len());
    let mut index = 0usize;
    let mut sum = _mm256_setzero_ps();

    while index + 8 <= len {
        // SAFETY: index bounds are guarded by loop condition and pointers are valid for 8 f32.
        let a = unsafe { _mm256_loadu_ps(coefficients.as_ptr().add(index)) };
        // SAFETY: index bounds are guarded by loop condition and pointers are valid for 8 f32.
        let b = unsafe { _mm256_loadu_ps(taps.as_ptr().add(index)) };
        let product = _mm256_mul_ps(a, b);
        sum = _mm256_add_ps(sum, product);
        index += 8;
    }

    let mut temp = [0.0_f32; 8];
    // SAFETY: temp has room for 8 f32 values.
    unsafe { _mm256_storeu_ps(temp.as_mut_ptr(), sum) };
    let mut acc = temp.iter().sum::<f32>();

    while index < len {
        acc += coefficients[index] * taps[index];
        index += 1;
    }

    acc
}

fn detect_avx2() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        std::arch::is_x86_feature_detected!("avx2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{integer_upsample_ratio, ShortFirOversamplingFilter};
    use crate::oversampling::coefficients::FilterSpec;
    use crate::oversampling::OversamplingFilter;

    #[test]
    fn detects_integer_ratios() {
        assert_eq!(integer_upsample_ratio(2.0), Some(2));
        assert_eq!(integer_upsample_ratio(7.999_999_9), Some(8));
        assert_eq!(integer_upsample_ratio(2.5), None);
        assert_eq!(integer_upsample_ratio(0.5), None);
    }

    #[test]
    fn outputs_ratio_times_input_samples() {
        let spec = FilterSpec::from_filter_id("sinc-m-mp", 2.0);
        let mut filter = ShortFirOversamplingFilter::new("sinc-m-mp", 2.0, 2, spec)
            .expect("filter should be created");
        let input = vec![1.0_f32, -1.0, 0.0, 0.0, 0.5, 0.5, -0.25, -0.25];
        let mut output = Vec::with_capacity(input.len() * 4);
        let written = filter
            .process_chunk(&input, &mut output)
            .expect("processing should succeed");
        assert_eq!(written, input.len() * 2);
        assert_eq!(output.len(), written);
    }

    #[test]
    fn flushes_tail_once() {
        let spec = FilterSpec::from_filter_id("sinc-s-mp", 2.0);
        let mut filter = ShortFirOversamplingFilter::new("sinc-s-mp", 2.0, 1, spec)
            .expect("filter should be created");
        let mut output = Vec::with_capacity(4096);
        let _ = filter
            .process_chunk(&[1.0, 0.0, 0.0, 0.0], &mut output)
            .expect("input process should work");
        let first_tail = filter
            .process_chunk(&[], &mut output)
            .expect("first tail flush should work");
        let second_tail = filter
            .process_chunk(&[], &mut output)
            .expect("second tail flush should work");
        assert!(first_tail > 0);
        assert_eq!(second_tail, 0);
    }
}
