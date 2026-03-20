use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetOutputModeParams {
    pub mode: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadParams {
    pub src: String,
    #[serde(default)]
    pub autoplay: bool,
    #[serde(default, rename = "loop")]
    pub loop_value: bool,
    #[serde(default)]
    pub start_at_seconds: Option<f64>,
    #[serde(default)]
    pub playback_rate: Option<f64>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub target_sample_rate_hz: Option<u32>,
    #[serde(default)]
    pub oversampling_filter_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekParams {
    pub position_seconds: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetVolumeParams {
    pub volume: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLoopParams {
    #[serde(rename = "loop")]
    pub loop_value: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPlaybackRateParams {
    pub playback_rate: f64,
}
