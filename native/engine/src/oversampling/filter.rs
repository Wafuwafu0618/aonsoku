pub trait OversamplingFilter: Send {
    fn filter_id(&self) -> &'static str;

    fn ratio(&self) -> f64;

    fn channels(&self) -> usize;

    fn process_chunk(&mut self, input: &[f32], output: &mut Vec<f32>) -> Result<usize, String>;

    fn reset(&mut self);

    fn latency_frames(&self) -> usize;
}
