//! Bounded native terminal-input bridge and editor shadow state.
//!
//! The reader is Unix-only at runtime. It owns no terminal modes and parses no
//! escape sequences; JavaScript remains authoritative and drains raw byte
//! chunks through the existing `StdinBuffer`.

use std::{
	collections::VecDeque,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	thread::{self, JoinHandle},
};

use napi::{
	Result, Status,
	bindgen_prelude::Buffer,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use parking_lot::{Condvar, Mutex};

const DEFAULT_QUEUE_BYTES: u32 = 256 * 1024;
const DEFAULT_READ_CHUNK_BYTES: u32 = 4 * 1024;
const MIN_QUEUE_BYTES: u32 = 8 * 1024;
const MAX_READ_CHUNK_BYTES: u32 = 64 * 1024;
const POLL_TIMEOUT_MS: i32 = 50;

type WakeCallback = ThreadsafeFunction<u32, UnknownReturnValue>;

#[napi(object)]
#[derive(Default)]
pub struct NativeInputOptions {
	pub queue_bytes:      Option<u32>,
	pub read_chunk_bytes: Option<u32>,
}

#[napi(object)]
pub struct NativeInputStats {
	pub queue_capacity_bytes: u32,
	pub queued_events:        u32,
	pub queued_bytes:         u32,
	pub events_read:          f64,
	pub bytes_read:           f64,
	pub events_dropped:       f64,
	pub bytes_dropped:        f64,
	pub wakes_sent:           f64,
	pub running:              bool,
	pub stopped:              bool,
	pub worker_failed:        bool,
	pub failure:              Option<String>,
}

struct InputState {
	queue:          VecDeque<Vec<u8>>,
	queued_bytes:   usize,
	events_read:    u64,
	bytes_read:     u64,
	events_dropped: u64,
	bytes_dropped:  u64,
	wakes_sent:     u64,
	worker_failed:  bool,
	failure:        Option<String>,
}

impl InputState {
	const fn new() -> Self {
		Self {
			queue:          VecDeque::new(),
			queued_bytes:   0,
			events_read:    0,
			bytes_read:     0,
			events_dropped: 0,
			bytes_dropped:  0,
			wakes_sent:     0,
			worker_failed:  false,
			failure:        None,
		}
	}
}

struct NativeInputCore {
	queue_capacity_bytes: usize,
	read_chunk_bytes:     usize,
	state:                Mutex<InputState>,
	space_ready:          Condvar,
	input_ready:          tokio::sync::Notify,
	wake_pending:         AtomicBool,
	running:              AtomicBool,
	stopped:              AtomicBool,
	callback:             Mutex<Option<WakeCallback>>,
	join:                 Mutex<Option<JoinHandle<()>>>,
}

impl NativeInputCore {
	fn new(callback: WakeCallback, options: NativeInputOptions) -> Arc<Self> {
		let read_chunk_bytes = options
			.read_chunk_bytes
			.unwrap_or(DEFAULT_READ_CHUNK_BYTES)
			.clamp(1, MAX_READ_CHUNK_BYTES) as usize;
		let queue_capacity_bytes = options
			.queue_bytes
			.unwrap_or(DEFAULT_QUEUE_BYTES)
			.max(MIN_QUEUE_BYTES)
			.max(read_chunk_bytes as u32) as usize;
		Arc::new(Self {
			queue_capacity_bytes,
			read_chunk_bytes,
			state: Mutex::new(InputState::new()),
			space_ready: Condvar::new(),
			input_ready: tokio::sync::Notify::new(),
			wake_pending: AtomicBool::new(false),
			running: AtomicBool::new(false),
			stopped: AtomicBool::new(false),
			callback: Mutex::new(Some(callback)),
			join: Mutex::new(None),
		})
	}

	fn start(self: &Arc<Self>) -> Result<bool> {
		if self.running.swap(true, Ordering::AcqRel) {
			return Ok(false);
		}
		self.stopped.store(false, Ordering::Release);
		let callback = self.callback.lock().take().ok_or_else(|| {
			self.running.store(false, Ordering::Release);
			napi::Error::from_reason("native input cannot be restarted after stop")
		})?;
		let core = Arc::clone(self);
		let handle = thread::Builder::new()
			.name("omp-terminal-input".into())
			.spawn(move || run_input_worker(core, callback))
			.map_err(|error| {
				self.running.store(false, Ordering::Release);
				napi::Error::from_reason(format!("failed to start terminal input worker: {error}"))
			})?;
		*self.join.lock() = Some(handle);
		Ok(true)
	}

	fn enqueue(&self, data: Vec<u8>, callback: &WakeCallback) -> bool {
		if data.is_empty() || self.stopped.load(Ordering::Acquire) {
			return false;
		}
		let priority = data.iter().any(|byte| *byte < 0x20 || *byte == 0x7f);
		let mut state = self.state.lock();
		if priority {
			while state.queued_bytes.saturating_add(data.len()) > self.queue_capacity_bytes
				&& !self.stopped.load(Ordering::Acquire)
			{
				self.space_ready.wait(&mut state);
			}
			if self.stopped.load(Ordering::Acquire) {
				return false;
			}
		} else if state.queued_bytes.saturating_add(data.len()) > self.queue_capacity_bytes {
			state.events_dropped = state.events_dropped.saturating_add(1);
			state.bytes_dropped = state.bytes_dropped.saturating_add(data.len() as u64);
			return false;
		}

		state.queued_bytes = state.queued_bytes.saturating_add(data.len());
		state.events_read = state.events_read.saturating_add(1);
		state.bytes_read = state.bytes_read.saturating_add(data.len() as u64);
		state.queue.push_back(data);
		let should_wake = !self.wake_pending.swap(true, Ordering::AcqRel);
		if should_wake {
			state.wakes_sent = state.wakes_sent.saturating_add(1);
		}
		drop(state);
		self.input_ready.notify_one();

		if should_wake {
			// Bun can leave a non-blocking TSFN call pending after JavaScript stdin is
			// detached and the event loop becomes otherwise idle. `WakeCallback` uses
			// an unbounded N-API queue, so Blocking never waits for queue capacity here;
			// it only guarantees that the idle loop is notified promptly.
			let status = callback.call(Ok(1), ThreadsafeFunctionCallMode::Blocking);
			if status != Status::Ok {
				self.wake_pending.store(false, Ordering::Release);
				self.record_failure(format!("native input wake callback failed: {status:?}"));
				return false;
			}
		}
		true
	}

	fn drain(&self, max_events: u32, max_bytes: u32) -> Vec<Buffer> {
		let event_limit = max_events.max(1) as usize;
		let byte_limit = max_bytes.max(1) as usize;
		let mut state = self.state.lock();
		let mut drained = Vec::new();
		let mut drained_bytes = 0usize;
		while drained.len() < event_limit {
			let Some(front) = state.queue.front() else {
				break;
			};
			if !drained.is_empty() && drained_bytes.saturating_add(front.len()) > byte_limit {
				break;
			}
			let event = state.queue.pop_front().expect("front event was present");
			state.queued_bytes = state.queued_bytes.saturating_sub(event.len());
			drained_bytes = drained_bytes.saturating_add(event.len());
			drained.push(Buffer::from(event));
		}
		if state.queue.is_empty() {
			self.wake_pending.store(false, Ordering::Release);
		}
		drop(state);
		self.space_ready.notify_all();
		drained
	}

	async fn wait_for_input(&self) -> bool {
		loop {
			let notified = self.input_ready.notified();
			{
				let state = self.state.lock();
				if !state.queue.is_empty() {
					return true;
				}
				if self.stopped.load(Ordering::Acquire)
					|| !self.running.load(Ordering::Acquire)
					|| state.worker_failed
				{
					return false;
				}
			}
			notified.await;
		}
	}

	fn stop(&self) -> bool {
		self.stopped.store(true, Ordering::Release);
		self.space_ready.notify_all();
		self.input_ready.notify_waiters();
		let handle = self.join.lock().take();
		let joined = handle.is_none_or(|handle| handle.join().is_ok());
		self.running.store(false, Ordering::Release);
		if !joined {
			self.record_failure("terminal input worker panicked".into());
		}
		joined
	}

	fn record_failure(&self, failure: String) {
		let mut state = self.state.lock();
		state.worker_failed = true;
		if state.failure.is_none() {
			state.failure = Some(failure);
		}
		self.stopped.store(true, Ordering::Release);
		self.space_ready.notify_all();
		self.input_ready.notify_waiters();
	}

	fn finish_worker(&self) {
		self.running.store(false, Ordering::Release);
		self.space_ready.notify_all();
		self.input_ready.notify_waiters();
	}

	fn stats(&self) -> NativeInputStats {
		let state = self.state.lock();
		NativeInputStats {
			queue_capacity_bytes: self.queue_capacity_bytes.min(u32::MAX as usize) as u32,
			queued_events:        state.queue.len().min(u32::MAX as usize) as u32,
			queued_bytes:         state.queued_bytes.min(u32::MAX as usize) as u32,
			events_read:          state.events_read as f64,
			bytes_read:           state.bytes_read as f64,
			events_dropped:       state.events_dropped as f64,
			bytes_dropped:        state.bytes_dropped as f64,
			wakes_sent:           state.wakes_sent as f64,
			running:              self.running.load(Ordering::Acquire),
			stopped:              self.stopped.load(Ordering::Acquire),
			worker_failed:        state.worker_failed,
			failure:              state.failure.clone(),
		}
	}
}

fn run_input_worker(core: Arc<NativeInputCore>, callback: WakeCallback) {
	#[cfg(unix)]
	if let Err(error) = run_unix_input_worker(&core, &callback) {
		core.record_failure(format!("terminal stdin read failed: {error}"));
	}
	#[cfg(not(unix))]
	core.record_failure("native terminal input is available only on Unix".into());
	core.finish_worker();
}

#[cfg(unix)]
fn run_unix_input_worker(core: &NativeInputCore, callback: &WakeCallback) -> std::io::Result<()> {
	use std::io;

	let mut poll_fd =
		libc::pollfd { fd: libc::STDIN_FILENO, events: libc::POLLIN, revents: 0 };
	let mut buffer = vec![0u8; core.read_chunk_bytes];
	while !core.stopped.load(Ordering::Acquire) {
		poll_fd.revents = 0;
		// SAFETY: `poll_fd` points to one initialized descriptor for this call.
		let ready = unsafe { libc::poll(&raw mut poll_fd, 1, POLL_TIMEOUT_MS) };
		if ready < 0 {
			let error = io::Error::last_os_error();
			if error.kind() == io::ErrorKind::Interrupted {
				continue;
			}
			return Err(error);
		}
		if ready == 0 {
			continue;
		}
		if poll_fd.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
			return Err(io::Error::other("stdin poll reported an error"));
		}
		if poll_fd.revents & libc::POLLHUP != 0 && poll_fd.revents & libc::POLLIN == 0 {
			break;
		}
		if poll_fd.revents & libc::POLLIN == 0 {
			continue;
		}
		// SAFETY: `buffer` is a valid writable allocation and fd 0 stays process-owned.
		let read =
			unsafe { libc::read(libc::STDIN_FILENO, buffer.as_mut_ptr().cast(), buffer.len()) };
		if read < 0 {
			let error = io::Error::last_os_error();
			if error.kind() == io::ErrorKind::Interrupted || error.kind() == io::ErrorKind::WouldBlock
			{
				continue;
			}
			return Err(error);
		}
		if read == 0 {
			break;
		}
		core.enqueue(buffer[..read as usize].to_vec(), callback);
	}
	Ok(())
}

#[napi]
pub struct NativeInput {
	core: Arc<NativeInputCore>,
}

#[napi]
impl NativeInput {
	#[napi(constructor)]
	pub fn new(
		#[napi(ts_arg_type = "(error: Error | null, wake: number) => void")] on_wake: WakeCallback,
		options: Option<NativeInputOptions>,
	) -> Self {
		Self { core: NativeInputCore::new(on_wake, options.unwrap_or_default()) }
	}

	#[napi]
	pub fn start(&self) -> Result<bool> {
		#[cfg(not(unix))]
		return Err(napi::Error::from_reason("native terminal input is available only on Unix"));
		#[cfg(unix)]
		self.core.start()
	}

	#[napi]
	pub fn read(&self, max_events: u32, max_bytes: u32) -> Vec<Buffer> {
		self.core.drain(max_events, max_bytes)
	}

	#[napi]
	pub async fn wait_for_input(&self) -> bool {
		self.core.wait_for_input().await
	}

	#[napi]
	pub fn stop(&self) -> bool {
		self.core.stop()
	}

	#[napi]
	pub fn stats(&self) -> NativeInputStats {
		self.core.stats()
	}
}

impl Drop for NativeInput {
	fn drop(&mut self) {
		self.core.stop();
	}
}

#[napi]
pub struct NativeEditorShadow {
	text:        String,
	cursor_line: u32,
	cursor_col:  u32,
	generation:  u64,
}

#[napi]
impl NativeEditorShadow {
	#[napi(constructor)]
	pub const fn new() -> Self {
		Self { text: String::new(), cursor_line: 0, cursor_col: 0, generation: 0 }
	}

	#[napi]
	pub fn reset(
		&mut self,
		text: String,
		cursor_line: u32,
		cursor_col: u32,
		generation: f64,
	) -> bool {
		let Some(generation) = valid_generation(generation) else {
			return false;
		};
		self.text = text;
		self.cursor_line = cursor_line;
		self.cursor_col = cursor_col;
		self.generation = generation;
		true
	}

	#[napi]
	#[allow(
		clippy::too_many_arguments,
		reason = "shadow contract mirrors before/after editor state"
	)]
	pub fn apply_printable(
		&mut self,
		input: String,
		before_text: String,
		before_line: u32,
		before_col: u32,
		after_text: String,
		after_line: u32,
		after_col: u32,
		generation: f64,
	) -> bool {
		let Some(generation) = valid_generation(generation) else {
			return false;
		};
		if generation <= self.generation
			|| before_line != 0
			|| after_line != 0
			|| before_text.contains('\n')
			|| after_text.contains('\n')
			|| input.is_empty()
			|| input.chars().any(char::is_control)
			|| self.text != before_text
			|| self.cursor_line != before_line
			|| self.cursor_col != before_col
		{
			return false;
		}
		let Some(byte_col) = utf16_col_to_byte(&before_text, before_col as usize) else {
			return false;
		};
		let expected_col = before_col.saturating_add(input.encode_utf16().count() as u32);
		let expected = format!("{}{}{}", &before_text[..byte_col], input, &before_text[byte_col..]);
		if expected != after_text || expected_col != after_col {
			return false;
		}
		self.text = after_text;
		self.cursor_line = after_line;
		self.cursor_col = after_col;
		self.generation = generation;
		true
	}
}

impl Default for NativeEditorShadow {
	fn default() -> Self {
		Self::new()
	}
}

fn valid_generation(value: f64) -> Option<u64> {
	if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > u64::MAX as f64 {
		return None;
	}
	Some(value as u64)
}

fn utf16_col_to_byte(text: &str, target: usize) -> Option<usize> {
	let mut utf16 = 0usize;
	for (byte, character) in text.char_indices() {
		if utf16 == target {
			return Some(byte);
		}
		utf16 = utf16.saturating_add(character.len_utf16());
		if utf16 > target {
			return None;
		}
	}
	(utf16 == target).then_some(text.len())
}

#[cfg(test)]
mod tests {
	use super::{NativeEditorShadow, utf16_col_to_byte};

	#[test]
	fn editor_shadow_validates_plain_printable_mutations() {
		let mut shadow = NativeEditorShadow::new();
		assert!(shadow.reset("ab".into(), 0, 1, 1.0));
		assert!(shadow.apply_printable("X".into(), "ab".into(), 0, 1, "aXb".into(), 0, 2, 2.0));
		assert!(!shadow.apply_printable("Y".into(), "ab".into(), 0, 1, "aYb".into(), 0, 2, 3.0));
	}

	#[test]
	fn editor_shadow_uses_utf16_cursor_columns() {
		let text = "a😀b";
		assert_eq!(utf16_col_to_byte(text, 3), Some("a😀".len()));
		let mut shadow = NativeEditorShadow::new();
		assert!(shadow.reset(text.into(), 0, 3, 1.0));
		assert!(shadow.apply_printable("界".into(), text.into(), 0, 3, "a😀界b".into(), 0, 4, 2.0));
	}

	#[test]
	fn editor_shadow_preserves_utf16_state_when_invalid_or_stale_generations_arrive() {
		let before = "a😀";
		let after = "a😀界";
		let mut shadow = NativeEditorShadow::new();
		assert!(shadow.reset(before.into(), 0, 3, 10.0));
		assert!(!shadow.reset("must not replace state".into(), 0, 0, f64::NAN));
		assert!(!shadow.apply_printable("界".into(), before.into(), 0, 3, after.into(), 0, 4, 10.0));
		assert!(shadow.apply_printable("界".into(), before.into(), 0, 3, after.into(), 0, 4, 11.0));
	}
}
