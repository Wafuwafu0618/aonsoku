use super::coefficients::FilterSpec;
use super::filter::OversamplingFilter;
use super::short_fir::integer_upsample_ratio;
use rustfft::num_complex::Complex32;
use rustfft::num_traits::Zero;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;

pub struct FftOlaOversamplingFilter {
    filter_id: &'static str,
    channels: usize,
    ratio: f64,
    upsample_ratio: usize,
    num_taps: usize,
    max_input_frames: usize,
    fft_len: usize,
    fft_forward: Arc<dyn Fft<f32>>,
    fft_inverse: Arc<dyn Fft<f32>>,
    phase_filter_spectra: Vec<Vec<Complex32>>,
    histories: Vec<Vec<f32>>,
    channel_input: Vec<Vec<f32>>,
    fft_input_scratch: Vec<Complex32>,
    fft_work_scratch: Vec<Complex32>,
    tail_frames_remaining: usize,
    tail_flushed: bool,
    has_seen_input: bool,
    latency_output_frames: usize,
}

impl FftOlaOversamplingFilter {
    pub fn new(
        filter_id: &'static str,
        ratio: f64,
        channels: usize,
        spec: FilterSpec,
        max_input_frames: usize,
    ) -> Result<Self, String> {
        if channels == 0 {
            return Err("FFT OLA filter channels must be greater than zero.".to_string());
        }
        if max_input_frames == 0 {
            return Err("FFT OLA filter max_input_frames must be greater than zero.".to_string());
        }
        if !ratio.is_finite() || ratio <= 0.0 {
            return Err("FFT OLA filter ratio must be a positive finite value.".to_string());
        }

        let Some(upsample_ratio) = integer_upsample_ratio(ratio) else {
            return Err(format!(
                "FFT OLA filter supports integer upsample ratios only (ratio={ratio:.6})."
            ));
        };
        if upsample_ratio <= 1 {
            return Err(format!(
                "FFT OLA filter requires ratio > 1.0 for resampling (ratio={ratio:.6})."
            ));
        }

        let num_taps = spec.num_taps.max(1);
        let history_len = num_taps.saturating_sub(1);

        let conv_len_max = max_input_frames.saturating_add(history_len.saturating_mul(2));
        let fft_len = next_power_of_two(conv_len_max.max(1));
        if fft_len < conv_len_max {
            return Err(format!(
                "FFT OLA plan length overflow (fft_len={fft_len}, conv_len_max={conv_len_max})."
            ));
        }

        let mut planner = FftPlanner::<f32>::new();
        let fft_forward = planner.plan_fft_forward(fft_len);
        let fft_inverse = planner.plan_fft_inverse(fft_len);

        let coefficients = spec.compute_polyphase_coefficients_shared();
        let phase_offsets = build_phase_offsets(coefficients.oversampling_factor, num_taps);
        let step_coeff_offsets = build_step_coeff_offsets(
            upsample_ratio,
            coefficients.oversampling_factor,
            &phase_offsets,
        );
        let mut phase_filter_spectra = Vec::with_capacity(step_coeff_offsets.len());
        for coeff_start in step_coeff_offsets {
            let mut impulse = vec![Complex32::zero(); fft_len];
            let coeff_slice = &coefficients.data[coeff_start..coeff_start + num_taps];
            for (tap, value) in coeff_slice.iter().enumerate() {
                impulse[tap].re = *value;
            }
            fft_forward.process(&mut impulse);
            phase_filter_spectra.push(impulse);
        }

        let mut histories = Vec::with_capacity(channels);
        for _ in 0..channels {
            histories.push(vec![0.0_f32; history_len]);
        }
        let mut channel_input = Vec::with_capacity(channels);
        for _ in 0..channels {
            channel_input.push(Vec::with_capacity(max_input_frames));
        }

        let latency_input_frames = (num_taps.saturating_sub(1)) as f64 * 0.5;
        let latency_output_frames = (latency_input_frames * upsample_ratio as f64).round() as usize;

        Ok(Self {
            filter_id,
            channels,
            ratio,
            upsample_ratio,
            num_taps,
            max_input_frames,
            fft_len,
            fft_forward,
            fft_inverse,
            phase_filter_spectra,
            histories,
            channel_input,
            fft_input_scratch: vec![Complex32::zero(); fft_len],
            fft_work_scratch: vec![Complex32::zero(); fft_len],
            tail_frames_remaining: num_taps.saturating_sub(1),
            tail_flushed: false,
            has_seen_input: false,
            latency_output_frames,
        })
    }

    fn required_output_samples(&self, input_frames: usize) -> usize {
        input_frames
            .saturating_mul(self.upsample_ratio)
            .saturating_mul(self.channels)
    }

    fn process_channel_slice(
        &mut self,
        channel: usize,
        input_slice: &[f32],
        frame_offset: usize,
        output: &mut [f32],
    ) -> Result<(), String> {
        if channel >= self.channels {
            return Err(format!(
                "FFT OLA channel index {} is out of bounds for {} channels.",
                channel, self.channels
            ));
        }

        let frames = input_slice.len();
        if frames == 0 {
            return Ok(());
        }
        if frames > self.max_input_frames {
            return Err(format!(
                "FFT OLA input frames {} exceed configured max_input_frames {}.",
                frames, self.max_input_frames
            ));
        }

        let history_len = self.num_taps.saturating_sub(1);
        let conv_len = frames.saturating_add(history_len.saturating_mul(2));
        if conv_len > self.fft_len {
            return Err(format!(
                "FFT OLA convolution length {} exceeds FFT plan length {}.",
                conv_len, self.fft_len
            ));
        }

        self.fft_input_scratch.fill(Complex32::zero());
        if history_len > 0 {
            for (index, value) in self.histories[channel].iter().copied().enumerate() {
                self.fft_input_scratch[index].re = value;
            }
        }
        for (index, value) in input_slice.iter().copied().enumerate() {
            self.fft_input_scratch[history_len + index].re = value;
        }

        self.fft_forward.process(&mut self.fft_input_scratch);
        let inverse_norm = 1.0_f32 / self.fft_len as f32;

        for (step_index, spectrum) in self.phase_filter_spectra.iter().enumerate() {
            self.fft_work_scratch.copy_from_slice(&self.fft_input_scratch);
            for (bin, filter_bin) in self.fft_work_scratch.iter_mut().zip(spectrum.iter()) {
                *bin *= *filter_bin;
            }
            self.fft_inverse.process(&mut self.fft_work_scratch);

            for frame in 0..frames {
                let filtered = self.fft_work_scratch[history_len + frame].re * inverse_norm;
                let output_index = ((frame_offset + frame)
                    .saturating_mul(self.upsample_ratio)
                    .saturating_add(step_index))
                .saturating_mul(self.channels)
                .saturating_add(channel);
                if output_index >= output.len() {
                    return Err(format!(
                        "FFT OLA output index {} exceeds output length {}.",
                        output_index,
                        output.len()
                    ));
                }
                output[output_index] = filtered;
            }
        }

        if history_len > 0 {
            if frames >= history_len {
                self.histories[channel].copy_from_slice(&input_slice[frames - history_len..frames]);
            } else {
                let keep_old = history_len - frames;
                self.histories[channel].copy_within(frames..history_len, 0);
                self.histories[channel][keep_old..history_len].copy_from_slice(input_slice);
            }
        }

        Ok(())
    }

    fn process_frames(&mut self, frames: usize, output: &mut [f32]) -> Result<(), String> {
        for channel in 0..self.channels {
            let mut channel_samples = std::mem::take(&mut self.channel_input[channel]);
            let mut frame_offset = 0usize;
            while frame_offset < frames {
                let end = (frame_offset + self.max_input_frames).min(frames);
                let input_slice = &channel_samples[frame_offset..end];
                self.process_channel_slice(channel, input_slice, frame_offset, output)?;
                frame_offset = end;
            }
            channel_samples.clear();
            self.channel_input[channel] = channel_samples;
        }
        Ok(())
    }

    fn process_zero_frames(&mut self, frames: usize, output: &mut [f32]) -> Result<(), String> {
        if frames == 0 {
            return Ok(());
        }

        let zero_block_len = self.max_input_frames.min(frames).max(1);
        let zero_block = vec![0.0_f32; zero_block_len];
        for channel in 0..self.channels {
            let mut frame_offset = 0usize;
            while frame_offset < frames {
                let remaining = frames - frame_offset;
                let chunk_len = remaining.min(zero_block_len);
                self.process_channel_slice(
                    channel,
                    &zero_block[..chunk_len],
                    frame_offset,
                    output,
                )?;
                frame_offset += chunk_len;
            }
        }

        Ok(())
    }
}

impl OversamplingFilter for FftOlaOversamplingFilter {
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

            let tail_frames = self.tail_frames_remaining;
            let required_samples = self.required_output_samples(tail_frames);
            if output.capacity() < required_samples {
                return Err(format!(
                    "Output buffer capacity {} is below required {} samples for FFT OLA tail flush.",
                    output.capacity(),
                    required_samples
                ));
            }
            output.clear();
            // SAFETY: required_samples is checked against capacity and fully written by process_zero_frames.
            unsafe { output.set_len(required_samples) };
            self.process_zero_frames(tail_frames, output)?;
            self.tail_frames_remaining = 0;
            self.tail_flushed = true;
            return Ok(required_samples);
        }

        if self.channels == 0 {
            output.clear();
            return Ok(0);
        }
        if input.len() % self.channels != 0 {
            return Err(format!(
                "Interleaved chunk size {} is not divisible by channel count {}.",
                input.len(),
                self.channels
            ));
        }

        let frames = input.len() / self.channels;
        let required_samples = self.required_output_samples(frames);
        if output.capacity() < required_samples {
            return Err(format!(
                "Output buffer capacity {} is below required {} samples for FFT OLA processing.",
                output.capacity(),
                required_samples
            ));
        }

        for channel in 0..self.channels {
            let channel_buffer = &mut self.channel_input[channel];
            channel_buffer.clear();
            if channel_buffer.capacity() < frames {
                channel_buffer.reserve(frames - channel_buffer.capacity());
            }
        }
        for frame in 0..frames {
            let base = frame * self.channels;
            for channel in 0..self.channels {
                self.channel_input[channel].push(input[base + channel]);
            }
        }

        output.clear();
        // SAFETY: required_samples is checked against capacity and fully written by process_frames.
        unsafe { output.set_len(required_samples) };
        self.process_frames(frames, output)?;

        self.tail_frames_remaining = self.num_taps.saturating_sub(1);
        self.tail_flushed = false;
        self.has_seen_input = true;
        Ok(required_samples)
    }

    fn reset(&mut self) {
        for history in &mut self.histories {
            history.fill(0.0);
        }
        self.tail_frames_remaining = self.num_taps.saturating_sub(1);
        self.tail_flushed = false;
        self.has_seen_input = false;
    }

    fn latency_frames(&self) -> usize {
        self.latency_output_frames
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

fn next_power_of_two(value: usize) -> usize {
    value.next_power_of_two()
}

#[cfg(test)]
mod tests {
    use super::FftOlaOversamplingFilter;
    use crate::oversampling::coefficients::FilterSpec;
    use crate::oversampling::OversamplingFilter;

    #[test]
    fn outputs_ratio_times_input_samples() {
        let spec = FilterSpec::from_filter_id("poly-sinc-long-lp", 2.0);
        let mut filter =
            FftOlaOversamplingFilter::new("poly-sinc-long-lp", 2.0, 2, spec, 512)
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
        let spec = FilterSpec::from_filter_id("poly-sinc-long-lp", 2.0);
        let mut filter =
            FftOlaOversamplingFilter::new("poly-sinc-long-lp", 2.0, 1, spec, 256)
                .expect("filter should be created");

        let mut output = Vec::with_capacity(8192);
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
