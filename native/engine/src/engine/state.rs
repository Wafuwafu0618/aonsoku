use std::time::Instant;

use crate::audio::{AnalogColorConfig, CrossfeedConfig, ParametricEqConfig};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    WasapiShared,
    WasapiExclusive,
    Asio,
}

impl OutputMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WasapiShared => "wasapi-shared",
            Self::WasapiExclusive => "wasapi-exclusive",
            Self::Asio => "asio",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "wasapi-shared" => Some(Self::WasapiShared),
            "wasapi-exclusive" => Some(Self::WasapiExclusive),
            "asio" => Some(Self::Asio),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackState {
    Idle,
    Ready,
    Playing,
    Paused,
    Ended,
}

#[derive(Debug, Clone)]
pub struct EngineState {
    pub initialized: bool,
    pub output_mode: OutputMode,
    pub source: Option<String>,
    pub playback_state: PlaybackState,
    pub volume: f64,
    pub loop_enabled: bool,
    pub playback_rate: f64,
    pub current_time_seconds: f64,
    pub duration_seconds: f64,
    pub target_sample_rate_hz: Option<u32>,
    pub oversampling_filter_id: Option<String>,
    pub headroom_db: f32,
    pub crossfeed: Option<CrossfeedConfig>,
    pub parametric_eq: Option<ParametricEqConfig>,
    pub analog_color: Option<AnalogColorConfig>,
    pub last_tick_instant: Option<Instant>,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            initialized: false,
            output_mode: OutputMode::WasapiShared,
            source: None,
            playback_state: PlaybackState::Idle,
            volume: 1.0,
            loop_enabled: false,
            playback_rate: 1.0,
            current_time_seconds: 0.0,
            duration_seconds: 0.0,
            target_sample_rate_hz: None,
            oversampling_filter_id: None,
            headroom_db: 0.0,
            crossfeed: None,
            parametric_eq: None,
            analog_color: None,
            last_tick_instant: None,
        }
    }
}

impl EngineState {
    pub fn is_playing(&self) -> bool {
        self.playback_state == PlaybackState::Playing
    }

    pub fn has_source(&self) -> bool {
        self.source.is_some()
    }

    pub fn reset_playback_session(&mut self) {
        self.source = None;
        self.playback_state = PlaybackState::Idle;
        self.loop_enabled = false;
        self.playback_rate = 1.0;
        self.current_time_seconds = 0.0;
        self.duration_seconds = 0.0;
        self.target_sample_rate_hz = None;
        self.oversampling_filter_id = None;
        self.headroom_db = 0.0;
        self.crossfeed = None;
        self.parametric_eq = None;
        self.analog_color = None;
        self.last_tick_instant = None;
    }

    pub fn set_current_time(&mut self, next_time: f64) {
        if self.duration_seconds > 0.0 {
            self.current_time_seconds = next_time.clamp(0.0, self.duration_seconds);
        } else {
            self.current_time_seconds = next_time.max(0.0);
        }
    }

    pub fn advance_clock(&mut self) -> bool {
        if !self.is_playing() {
            return false;
        }

        let now = Instant::now();
        if let Some(last_tick) = self.last_tick_instant {
            let elapsed_seconds = now.saturating_duration_since(last_tick).as_secs_f64();
            if elapsed_seconds > 0.0 {
                self.current_time_seconds += elapsed_seconds * self.playback_rate;
            }
        }
        self.last_tick_instant = Some(now);

        if self.duration_seconds <= 0.0 {
            return false;
        }

        if self.current_time_seconds < self.duration_seconds {
            return false;
        }

        if self.loop_enabled {
            self.current_time_seconds %= self.duration_seconds;
            return false;
        }

        self.current_time_seconds = self.duration_seconds;
        self.playback_state = PlaybackState::Ended;
        self.last_tick_instant = None;
        true
    }

    pub fn start_playback(&mut self) -> Result<(), (&'static str, &'static str)> {
        if !self.has_source() {
            return Err(("no-source", "No audio source has been loaded."));
        }

        if self.playback_state == PlaybackState::Ended {
            self.current_time_seconds = 0.0;
        }

        self.playback_state = PlaybackState::Playing;
        self.last_tick_instant = Some(Instant::now());
        Ok(())
    }

    pub fn pause_playback(&mut self) {
        if self.is_playing() {
            self.advance_clock();
        }

        if self.playback_state != PlaybackState::Ended {
            self.playback_state = PlaybackState::Paused;
        }
        self.last_tick_instant = None;
    }
}
