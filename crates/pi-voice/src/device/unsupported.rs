//! Stub backend for platforms without a native audio implementation.

use std::sync::Arc;

use super::{CaptureSink, DeviceConfig, PlaybackFill, PlaybackStopSignal};
use crate::VoiceResult;

const UNSUPPORTED: &str = "Native audio is not supported on this platform";

pub struct PlaybackDevice;

impl PlaybackDevice {
	pub fn start(
		_config: DeviceConfig,
		_fill: PlaybackFill,
		_stop_signal: Arc<dyn PlaybackStopSignal>,
	) -> VoiceResult<Self> {
		Err(UNSUPPORTED.to_owned())
	}

	pub fn stop(&mut self) -> VoiceResult<()> {
		Ok(())
	}
}

pub struct CaptureDevice;

impl CaptureDevice {
	pub fn start(_config: DeviceConfig, _sink: CaptureSink) -> VoiceResult<Self> {
		Err(UNSUPPORTED.to_owned())
	}

	pub fn stop(&mut self) -> VoiceResult<()> {
		Ok(())
	}
}
