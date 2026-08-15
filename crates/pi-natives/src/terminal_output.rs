//! Serialized, bounded terminal-output ownership for the TypeScript TUI.
//!
//! A single native worker owns stdout while a broker is alive. Reliable writes
//! preserve FIFO order, while only the newest pending frame is retained.

use std::{
	collections::VecDeque,
	io::{self, ErrorKind, Write},
	panic::{self, AssertUnwindSafe},
	sync::Arc,
	thread::{self, JoinHandle},
	time::{Duration, Instant},
};

use napi::Result;
use napi_derive::napi;
use parking_lot::{Condvar, Mutex};

const DEFAULT_RELIABLE_CAPACITY: u32 = 64;
const DEFAULT_TIMEOUT_MS: u32 = 1_000;
const REAP_POLL_INTERVAL: Duration = Duration::from_millis(1);

/// Options accepted by [`TerminalOutputBroker`].
#[napi(object)]
#[derive(Default)]
pub struct TerminalOutputBrokerOptions {
	/// Maximum number of reliable writes waiting behind the worker.
	pub reliable_capacity: Option<u32>,
}

/// Snapshot of native terminal-output state.
#[napi(object)]
pub struct TerminalOutputBrokerStats {
	pub reliable_capacity:    u32,
	pub reliable_queued:      u32,
	pub reliable_accepted:    f64,
	pub reliable_written:     f64,
	pub reliable_rejected:    f64,
	pub latest_accepted:      f64,
	pub latest_written:       f64,
	pub latest_rejected:      f64,
	pub latest_superseded:    f64,
	pub latest_pending:       bool,
	pub last_latest_frame_id: Option<f64>,
	pub closed:               bool,
	pub worker_finished:      bool,
	pub worker_failed:        bool,
	pub failure:              Option<String>,
}

struct QueuedReliable {
	sequence: u64,
	data:     Vec<u8>,
}

struct LatestWrite {
	sequence: u64,
	data:     Vec<u8>,
}

struct State {
	reliable:             VecDeque<QueuedReliable>,
	latest:               Option<LatestWrite>,
	last_latest_frame_id: Option<f64>,
	next_sequence:        u64,
	reliable_accepted:    u64,
	reliable_written:     u64,
	reliable_rejected:    u64,
	latest_accepted:      u64,
	latest_written:       u64,
	latest_rejected:      u64,
	latest_superseded:    u64,
	flush_requested:      u64,
	flushed_reliable:     u64,
	closed:               bool,
	worker_finished:      bool,
	worker_failed:        bool,
	failure:              Option<String>,
}

impl State {
	const fn new() -> Self {
		Self {
			reliable:             VecDeque::new(),
			latest:               None,
			last_latest_frame_id: None,
			next_sequence:        1,
			reliable_accepted:    0,
			reliable_written:     0,
			reliable_rejected:    0,
			latest_accepted:      0,
			latest_written:       0,
			latest_rejected:      0,
			latest_superseded:    0,
			flush_requested:      0,
			flushed_reliable:     0,
			closed:               false,
			worker_finished:      false,
			worker_failed:        false,
			failure:              None,
		}
	}

	fn accepts_writes(&self) -> bool {
		!self.closed && !self.worker_finished && !self.worker_failed
	}

	fn take_sequence(&mut self) -> u64 {
		let sequence = self.next_sequence;
		self.next_sequence = self.next_sequence.saturating_add(1);
		sequence
	}
}

enum WorkerCommand {
	Reliable(Vec<u8>),
	Latest(Vec<u8>),
	Flush(u64),
	Stop,
}

/// Shared state and the owned worker handle. The worker holds an `Arc` until it
/// exits, so dropping the JavaScript wrapper can request cleanup without
/// turning a still-live worker into a detached thread.
struct TerminalOutputCore {
	reliable_capacity: u32,
	state:             Mutex<State>,
	work_ready:        Condvar,
	progress:          Condvar,
	join:              Mutex<Option<JoinHandle<()>>>,
}

impl TerminalOutputCore {
	fn start<W>(writer: W, reliable_capacity: u32) -> io::Result<Arc<Self>>
	where
		W: Write + Send + 'static,
	{
		let core = Arc::new(Self {
			reliable_capacity,
			state: Mutex::new(State::new()),
			work_ready: Condvar::new(),
			progress: Condvar::new(),
			join: Mutex::new(None),
		});
		let worker_core = Arc::clone(&core);
		let handle = thread::Builder::new()
			.name("omp-terminal-output".into())
			.spawn(move || run_worker(worker_core, writer))?;
		*core.join.lock() = Some(handle);
		Ok(core)
	}

	fn enqueue_reliable(&self, data: String) -> bool {
		let mut state = self.state.lock();
		if !state.accepts_writes() || state.reliable.len() >= self.reliable_capacity as usize {
			bump(&mut state.reliable_rejected);
			return false;
		}

		let sequence = state.take_sequence();
		state
			.reliable
			.push_back(QueuedReliable { sequence, data: data.into_bytes() });
		bump(&mut state.reliable_accepted);
		self.work_ready.notify_one();
		true
	}

	fn enqueue_latest(&self, frame_id: f64, data: String) -> bool {
		let mut state = self.state.lock();
		if !frame_id.is_finite()
			|| !state.accepts_writes()
			|| matches!(state.last_latest_frame_id, Some(last) if frame_id <= last)
		{
			bump(&mut state.latest_rejected);
			return false;
		}

		let sequence = state.take_sequence();
		state.last_latest_frame_id = Some(frame_id);
		bump(&mut state.latest_accepted);
		if state
			.latest
			.replace(LatestWrite { sequence, data: data.into_bytes() })
			.is_some()
		{
			bump(&mut state.latest_superseded);
		}
		self.work_ready.notify_one();
		true
	}

	/// Request a physical flush after all reliable writes accepted before this
	/// call. The target sequence number is an ordered barrier without a second,
	/// potentially unbounded control queue.
	fn flush(&self, timeout: Duration) -> bool {
		let deadline = Instant::now() + timeout;
		let mut state = self.state.lock();
		if state.worker_failed {
			return false;
		}

		let target = state.reliable_accepted;
		if state.flushed_reliable < target {
			state.flush_requested = state.flush_requested.max(target);
			self.work_ready.notify_one();
		}

		loop {
			if state.flushed_reliable >= target {
				return !state.worker_failed;
			}
			if state.worker_failed || state.worker_finished {
				return false;
			}
			let Some(remaining) = remaining_until(deadline) else {
				return false;
			};
			let timed_out = self.progress.wait_for(&mut state, remaining).timed_out();
			if timed_out && state.flushed_reliable < target {
				return false;
			}
		}
	}

	/// Stop accepting work, discard a not-yet-started latest frame, and ensure
	/// all accepted reliable writes are physically flushed before the worker
	/// exits.
	fn close(&self, timeout: Duration) -> bool {
		let deadline = Instant::now() + timeout;
		self.request_close();
		if !self.wait_for_worker(deadline) {
			return false;
		}
		self.reap_worker(deadline)
	}

	fn request_close(&self) {
		let mut state = self.state.lock();
		state.closed = true;
		state.latest = None;
		state.flush_requested = state.flush_requested.max(state.reliable_accepted);
		self.work_ready.notify_all();
	}

	fn wait_for_worker(&self, deadline: Instant) -> bool {
		let mut state = self.state.lock();
		loop {
			if state.worker_finished {
				return !state.worker_failed;
			}
			let Some(remaining) = remaining_until(deadline) else {
				return false;
			};
			let timed_out = self.progress.wait_for(&mut state, remaining).timed_out();
			if timed_out && !state.worker_finished {
				return false;
			}
		}
	}

	/// `JoinHandle::join` itself has no timeout. Only join after `is_finished`,
	/// and otherwise poll only until the caller's existing deadline.
	fn reap_worker(&self, deadline: Instant) -> bool {
		loop {
			let handle = {
				let mut join = self.join.lock();
				match join.as_ref() {
					None => return true,
					Some(handle) if handle.is_finished() => join.take(),
					Some(_) => None,
				}
			};
			if let Some(handle) = handle {
				if handle.join().is_ok() {
					return true;
				}
				self.record_join_failure();
				return false;
			}

			let Some(remaining) = remaining_until(deadline) else {
				return false;
			};
			thread::sleep(remaining.min(REAP_POLL_INTERVAL));
		}
	}

	fn next_command(&self) -> WorkerCommand {
		let mut state = self.state.lock();
		loop {
			if state.flush_requested > state.flushed_reliable
				&& state.reliable_written >= state.flush_requested
			{
				return WorkerCommand::Flush(state.flush_requested);
			}
			let latest_before_reliable = match (state.latest.as_ref(), state.reliable.front()) {
				(Some(latest), Some(reliable)) => latest.sequence < reliable.sequence,
				(Some(_), None) => true,
				_ => false,
			};
			if latest_before_reliable {
				let latest = state.latest.take().expect("latest write was present");
				return WorkerCommand::Latest(latest.data);
			}
			if let Some(reliable) = state.reliable.pop_front() {
				return WorkerCommand::Reliable(reliable.data);
			}
			if state.closed {
				return WorkerCommand::Stop;
			}
			self.work_ready.wait(&mut state);
		}
	}

	fn reliable_written(&self) {
		let mut state = self.state.lock();
		bump(&mut state.reliable_written);
		self.progress.notify_all();
	}

	fn latest_written(&self) {
		let mut state = self.state.lock();
		bump(&mut state.latest_written);
		self.progress.notify_all();
	}

	fn reliable_flushed(&self, target: u64) {
		let mut state = self.state.lock();
		state.flushed_reliable = state.flushed_reliable.max(target);
		self.progress.notify_all();
	}

	fn finish_worker(&self, failure: Option<String>) {
		let mut state = self.state.lock();
		if let Some(failure) = failure {
			state.closed = true;
			state.worker_failed = true;
			if state.failure.is_none() {
				state.failure = Some(failure);
			}
			state.reliable.clear();
			state.latest = None;
		}
		state.worker_finished = true;
		self.progress.notify_all();
		self.work_ready.notify_all();
	}

	fn record_join_failure(&self) {
		let mut state = self.state.lock();
		state.closed = true;
		state.worker_failed = true;
		state.worker_finished = true;
		if state.failure.is_none() {
			state.failure = Some("terminal output worker panicked".into());
		}
		state.reliable.clear();
		state.latest = None;
		self.progress.notify_all();
		self.work_ready.notify_all();
	}

	fn stats(&self) -> TerminalOutputBrokerStats {
		let state = self.state.lock();
		TerminalOutputBrokerStats {
			reliable_capacity:    self.reliable_capacity,
			reliable_queued:      state.reliable.len() as u32,
			reliable_accepted:    state.reliable_accepted as f64,
			reliable_written:     state.reliable_written as f64,
			reliable_rejected:    state.reliable_rejected as f64,
			latest_accepted:      state.latest_accepted as f64,
			latest_written:       state.latest_written as f64,
			latest_rejected:      state.latest_rejected as f64,
			latest_superseded:    state.latest_superseded as f64,
			latest_pending:       state.latest.is_some(),
			last_latest_frame_id: state.last_latest_frame_id,
			closed:               state.closed,
			worker_finished:      state.worker_finished,
			worker_failed:        state.worker_failed,
			failure:              state.failure.clone(),
		}
	}
}

fn run_worker<W>(core: Arc<TerminalOutputCore>, mut writer: W)
where
	W: Write,
{
	let failure = match panic::catch_unwind(AssertUnwindSafe(|| worker_loop(&core, &mut writer))) {
		Ok(Ok(())) => None,
		Ok(Err(error)) => Some(format!("terminal stdout write failed: {error}")),
		Err(_) => Some("terminal output worker panicked".into()),
	};
	core.finish_worker(failure);
}

fn worker_loop<W>(core: &TerminalOutputCore, writer: &mut W) -> io::Result<()>
where
	W: Write,
{
	loop {
		match core.next_command() {
			WorkerCommand::Reliable(data) => {
				write_all_retry(writer, &data)?;
				// `io::Stdout` is line-buffered on terminals. HUD echoes and compact
				// differential frames commonly contain no newline, so flush on the
				// worker thread before publishing completion.
				flush_retry(writer)?;
				core.reliable_written();
			},
			WorkerCommand::Latest(data) => {
				write_all_retry(writer, &data)?;
				flush_retry(writer)?;
				core.latest_written();
			},
			WorkerCommand::Flush(target) => {
				flush_retry(writer)?;
				core.reliable_flushed(target);
			},
			WorkerCommand::Stop => return Ok(()),
		}
	}
}

fn write_all_retry<W>(writer: &mut W, mut data: &[u8]) -> io::Result<()>
where
	W: Write,
{
	while !data.is_empty() {
		match writer.write(data) {
			Ok(0) => {
				return Err(io::Error::new(
					ErrorKind::WriteZero,
					"terminal stdout writer wrote zero bytes",
				));
			},
			Ok(written) if written <= data.len() => data = &data[written..],
			Ok(_) => {
				return Err(io::Error::new(
					ErrorKind::InvalidData,
					"terminal stdout writer reported an invalid byte count",
				));
			},
			Err(error) if error.kind() == ErrorKind::Interrupted => continue,
			Err(error) => return Err(error),
		}
	}
	Ok(())
}

fn flush_retry<W>(writer: &mut W) -> io::Result<()>
where
	W: Write,
{
	loop {
		match writer.flush() {
			Ok(()) => return Ok(()),
			Err(error) if error.kind() == ErrorKind::Interrupted => continue,
			Err(error) => return Err(error),
		}
	}
}

fn bump(counter: &mut u64) {
	*counter = counter.saturating_add(1);
}

fn remaining_until(deadline: Instant) -> Option<Duration> {
	let remaining = deadline.checked_duration_since(Instant::now())?;
	if remaining.is_zero() {
		None
	} else {
		Some(remaining)
	}
}

fn timeout_duration(timeout_ms: Option<u32>) -> Duration {
	Duration::from_millis(u64::from(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS)))
}

/// Cross-thread terminal-output owner exposed to TypeScript.
#[napi]
pub struct TerminalOutputBroker {
	core: Arc<TerminalOutputCore>,
}

#[napi]
impl TerminalOutputBroker {
	#[napi(constructor)]
	pub fn new(options: Option<TerminalOutputBrokerOptions>) -> Result<Self> {
		let reliable_capacity = options
			.and_then(|options| options.reliable_capacity)
			.unwrap_or(DEFAULT_RELIABLE_CAPACITY);
		let core = TerminalOutputCore::start(io::stdout(), reliable_capacity).map_err(|error| {
			napi::Error::from_reason(format!("failed to start terminal output worker: {error}"))
		})?;
		Ok(Self { core })
	}

	#[napi]
	pub fn write_reliable(&self, data: String) -> bool {
		self.core.enqueue_reliable(data)
	}

	#[napi]
	pub fn write_latest(&self, frame_id: f64, data: String) -> bool {
		self.core.enqueue_latest(frame_id, data)
	}

	#[napi]
	pub fn flush(&self, timeout_ms: Option<u32>) -> bool {
		self.core.flush(timeout_duration(timeout_ms))
	}

	#[napi]
	pub fn close(&self, timeout_ms: Option<u32>) -> bool {
		self.core.close(timeout_duration(timeout_ms))
	}

	#[napi]
	pub fn stats(&self) -> TerminalOutputBrokerStats {
		self.core.stats()
	}
}

impl Drop for TerminalOutputBroker {
	fn drop(&mut self) {
		self.core.request_close();
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const TEST_TIMEOUT: Duration = Duration::from_secs(1);

	struct MemorySink {
		state:   Mutex<MemorySinkState>,
		changed: Condvar,
	}

	struct MemorySinkState {
		bytes:   Vec<u8>,
		flushes: u32,
	}

	impl MemorySink {
		fn new() -> Arc<Self> {
			Arc::new(Self {
				state:   Mutex::new(MemorySinkState { bytes: Vec::new(), flushes: 0 }),
				changed: Condvar::new(),
			})
		}

		fn append(&self, bytes: &[u8]) {
			let mut state = self.state.lock();
			state.bytes.extend_from_slice(bytes);
			self.changed.notify_all();
		}

		fn flushed(&self) {
			let mut state = self.state.lock();
			state.flushes = state.flushes.saturating_add(1);
			self.changed.notify_all();
		}

		fn bytes(&self) -> Vec<u8> {
			self.state.lock().bytes.clone()
		}

		fn flushes(&self) -> u32 {
			self.state.lock().flushes
		}

		fn wait_for_bytes(&self, expected: &[u8], timeout: Duration) -> bool {
			let deadline = Instant::now() + timeout;
			let mut state = self.state.lock();
			loop {
				if state.bytes == expected {
					return true;
				}
				let Some(remaining) = remaining_until(deadline) else {
					return false;
				};
				if self.changed.wait_for(&mut state, remaining).timed_out() && state.bytes != expected {
					return false;
				}
			}
		}
	}

	struct WriteGate {
		state:   Mutex<WriteGateState>,
		changed: Condvar,
	}

	struct WriteGateState {
		entered:        bool,
		released:       bool,
		flush_entered:  bool,
		flush_released: bool,
	}

	impl WriteGate {
		fn new() -> Arc<Self> {
			Arc::new(Self {
				state:   Mutex::new(WriteGateState {
					entered:        false,
					released:       false,
					flush_entered:  false,
					flush_released: false,
				}),
				changed: Condvar::new(),
			})
		}

		fn block_first_write(&self) {
			let mut state = self.state.lock();
			if state.entered {
				return;
			}
			state.entered = true;
			self.changed.notify_all();
			while !state.released {
				self.changed.wait(&mut state);
			}
		}

		fn wait_started(&self, timeout: Duration) -> bool {
			let deadline = Instant::now() + timeout;
			let mut state = self.state.lock();
			while !state.entered {
				let Some(remaining) = remaining_until(deadline) else {
					return false;
				};
				if self.changed.wait_for(&mut state, remaining).timed_out() && !state.entered {
					return false;
				}
			}
			true
		}

		fn release(&self) {
			let mut state = self.state.lock();
			state.released = true;
			self.changed.notify_all();
		}

		fn block_first_flush(&self) {
			let mut state = self.state.lock();
			if state.flush_entered {
				return;
			}
			state.flush_entered = true;
			self.changed.notify_all();
			while !state.flush_released {
				self.changed.wait(&mut state);
			}
		}

		fn wait_flush_started(&self, timeout: Duration) -> bool {
			let deadline = Instant::now() + timeout;
			let mut state = self.state.lock();
			while !state.flush_entered {
				let Some(remaining) = remaining_until(deadline) else {
					return false;
				};
				if self.changed.wait_for(&mut state, remaining).timed_out() && !state.flush_entered {
					return false;
				}
			}
			true
		}

		fn release_flush(&self) {
			let mut state = self.state.lock();
			state.flush_released = true;
			self.changed.notify_all();
		}
	}

	struct MemoryWriter {
		sink:            Arc<MemorySink>,
		gate:            Option<Arc<WriteGate>>,
		flush_gate:      Option<Arc<WriteGate>>,
		interrupt_first: bool,
		chunk_limit:     usize,
	}

	impl MemoryWriter {
		fn new(sink: Arc<MemorySink>) -> Self {
			Self {
				sink,
				gate: None,
				flush_gate: None,
				interrupt_first: false,
				chunk_limit: usize::MAX,
			}
		}

		fn gated(mut self, gate: Arc<WriteGate>) -> Self {
			self.gate = Some(gate);
			self
		}

		fn flush_gated(mut self, gate: Arc<WriteGate>) -> Self {
			self.flush_gate = Some(gate);
			self
		}

		fn interrupted_and_partial(mut self) -> Self {
			self.interrupt_first = true;
			self.chunk_limit = 1;
			self
		}
	}

	impl Write for MemoryWriter {
		fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
			if self.interrupt_first {
				self.interrupt_first = false;
				return Err(io::Error::from(ErrorKind::Interrupted));
			}
			if let Some(gate) = &self.gate {
				gate.block_first_write();
			}
			let written = bytes.len().min(self.chunk_limit);
			self.sink.append(&bytes[..written]);
			Ok(written)
		}

		fn flush(&mut self) -> io::Result<()> {
			if let Some(gate) = &self.flush_gate {
				gate.block_first_flush();
			}
			self.sink.flushed();
			Ok(())
		}
	}

	#[test]
	fn reliable_writes_preserve_fifo_order() {
		let sink = MemorySink::new();
		let core = TerminalOutputCore::start(MemoryWriter::new(Arc::clone(&sink)), 4).unwrap();

		assert!(core.enqueue_reliable("first".into()));
		assert!(core.enqueue_reliable("second".into()));
		assert!(core.flush(TEST_TIMEOUT));
		assert_eq!(sink.bytes(), b"firstsecond");
		assert!(sink.flushes() >= 1);
		assert!(core.close(TEST_TIMEOUT));
	}

	#[test]
	fn reliable_write_without_newline_flushes_before_publishing_completion() {
		let sink = MemorySink::new();
		let flush_gate = WriteGate::new();
		let core = TerminalOutputCore::start(
			MemoryWriter::new(Arc::clone(&sink)).flush_gated(Arc::clone(&flush_gate)),
			1,
		)
		.unwrap();

		assert!(core.enqueue_reliable("hud".into()));
		let flush_started = flush_gate.wait_flush_started(TEST_TIMEOUT);
		let bytes_before_flush = sink.bytes();
		let flushes_before_release = sink.flushes();
		let written_before_flush = core.stats().reliable_written;
		flush_gate.release_flush();
		let closed = core.close(TEST_TIMEOUT);

		assert!(flush_started);
		assert_eq!(bytes_before_flush, b"hud");
		assert_eq!(flushes_before_release, 0);
		assert_eq!(written_before_flush, 0.0);
		assert!(closed);
		assert_eq!(core.stats().reliable_written, 1.0);
		assert!(sink.flushes() >= 1);
	}

	#[test]
	fn latest_write_without_newline_flushes_before_publishing_completion() {
		let sink = MemorySink::new();
		let flush_gate = WriteGate::new();
		let core = TerminalOutputCore::start(
			MemoryWriter::new(Arc::clone(&sink)).flush_gated(Arc::clone(&flush_gate)),
			1,
		)
		.unwrap();

		assert!(core.enqueue_latest(1.0, "frame".into()));
		let flush_started = flush_gate.wait_flush_started(TEST_TIMEOUT);
		let bytes_before_flush = sink.bytes();
		let flushes_before_release = sink.flushes();
		let written_before_flush = core.stats().latest_written;
		flush_gate.release_flush();
		let closed = core.close(TEST_TIMEOUT);

		assert!(flush_started);
		assert_eq!(bytes_before_flush, b"frame");
		assert_eq!(flushes_before_release, 0);
		assert_eq!(written_before_flush, 0.0);
		assert!(closed);
		assert_eq!(core.stats().latest_written, 1.0);
		assert!(sink.flushes() >= 1);
	}

	#[test]
	fn reliable_queue_rejects_when_full() {
		let sink = MemorySink::new();
		let gate = WriteGate::new();
		let core = TerminalOutputCore::start(
			MemoryWriter::new(Arc::clone(&sink)).gated(Arc::clone(&gate)),
			1,
		)
		.unwrap();

		assert!(core.enqueue_reliable("one".into()));
		assert!(gate.wait_started(TEST_TIMEOUT));
		assert!(core.enqueue_reliable("two".into()));
		assert!(!core.enqueue_reliable("three".into()));
		let stats = core.stats();
		assert_eq!(stats.reliable_queued, 1);
		assert_eq!(stats.reliable_rejected, 1.0);

		gate.release();
		assert!(core.close(TEST_TIMEOUT));
		assert_eq!(sink.bytes(), b"onetwo");
	}

	#[test]
	fn latest_rejects_stale_frames_and_preserves_cross_channel_enqueue_order() {
		let sink = MemorySink::new();
		let gate = WriteGate::new();
		let core = TerminalOutputCore::start(
			MemoryWriter::new(Arc::clone(&sink)).gated(Arc::clone(&gate)),
			2,
		)
		.unwrap();

		assert!(core.enqueue_reliable("reliable".into()));
		assert!(gate.wait_started(TEST_TIMEOUT));
		assert!(core.enqueue_latest(10.0, "old".into()));
		assert!(core.enqueue_latest(11.0, "new".into()));
		assert!(core.enqueue_reliable("after".into()));
		assert!(!core.enqueue_latest(10.0, "stale".into()));
		let stats = core.stats();
		assert_eq!(stats.latest_accepted, 2.0);
		assert_eq!(stats.latest_superseded, 1.0);
		assert_eq!(stats.latest_rejected, 1.0);
		assert_eq!(stats.last_latest_frame_id, Some(11.0));
		assert!(stats.latest_pending);

		gate.release();
		assert!(sink.wait_for_bytes(b"reliablenewafter", TEST_TIMEOUT));
		let stats = core.stats();
		assert_eq!(stats.latest_written, 1.0);
		assert!(!stats.latest_pending);
		assert!(core.close(TEST_TIMEOUT));
	}

	#[test]
	fn flush_is_a_reliable_barrier_and_close_drains_reliable_output() {
		let sink = MemorySink::new();
		let gate = WriteGate::new();
		let core = TerminalOutputCore::start(
			MemoryWriter::new(Arc::clone(&sink)).gated(Arc::clone(&gate)),
			2,
		)
		.unwrap();

		assert!(core.enqueue_reliable("before".into()));
		assert!(gate.wait_started(TEST_TIMEOUT));
		let flushed_while_blocked = core.flush(Duration::from_millis(5));
		gate.release();
		assert!(!flushed_while_blocked);
		assert!(core.flush(TEST_TIMEOUT));
		assert_eq!(sink.bytes(), b"before");

		assert!(core.enqueue_reliable("after".into()));
		assert!(core.close(TEST_TIMEOUT));
		assert_eq!(sink.bytes(), b"beforeafter");
		assert!(core.close(Duration::from_millis(1)));
		assert!(!core.enqueue_reliable("rejected".into()));
	}

	#[test]
	fn pending_latest_does_not_delay_a_ready_reliable_flush() {
		let sink = MemorySink::new();
		let write_gate = WriteGate::new();
		let flush_gate = WriteGate::new();
		let core = TerminalOutputCore::start(
			MemoryWriter::new(Arc::clone(&sink))
				.gated(Arc::clone(&write_gate))
				.flush_gated(Arc::clone(&flush_gate)),
			2,
		)
		.unwrap();

		let reliable_accepted = core.enqueue_reliable("reliable".into());
		let write_started = write_gate.wait_started(TEST_TIMEOUT);
		let latest_accepted = core.enqueue_latest(1.0, "latest".into());

		let flushing_core = Arc::clone(&core);
		let flush = thread::spawn(move || flushing_core.flush(TEST_TIMEOUT));
		write_gate.release();

		let flush_started = flush_gate.wait_flush_started(TEST_TIMEOUT);
		let bytes_before_flush = sink.bytes();
		flush_gate.release_flush();
		let flushed = flush.join().unwrap();
		let latest_written = sink.wait_for_bytes(b"reliablelatest", TEST_TIMEOUT);
		let closed = core.close(TEST_TIMEOUT);

		assert!(reliable_accepted);
		assert!(write_started);
		assert!(latest_accepted);
		assert!(flush_started);
		assert_eq!(bytes_before_flush, b"reliable");
		assert!(flushed);
		assert!(latest_written);
		assert!(closed);
	}

	#[test]
	fn worker_retries_interrupted_and_partial_writes() {
		let sink = MemorySink::new();
		let core = TerminalOutputCore::start(
			MemoryWriter::new(Arc::clone(&sink)).interrupted_and_partial(),
			1,
		)
		.unwrap();

		assert!(core.enqueue_reliable("abc".into()));
		assert!(core.flush(TEST_TIMEOUT));
		assert_eq!(sink.bytes(), b"abc");
		assert!(core.close(TEST_TIMEOUT));
	}
}
