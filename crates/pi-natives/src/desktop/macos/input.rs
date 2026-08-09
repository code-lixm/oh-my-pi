use std::{
	ffi::c_void,
	thread,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use core_graphics::{
	event::{
		CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
		ScrollEventUnit,
	},
	event_source::{CGEventSource, CGEventSourceStateID},
	geometry::CGPoint,
	sys::CGEventSourceRef,
};
use foreign_types::ForeignType;

use super::{
	super::{
		backend::{DeliveryMode, Modifiers, MouseButton, PointerEvent},
		error::{CoreResult, DesktopError},
		keys::KeyName,
		types::{DesktopWindow, Target},
	},
	ax,
	capture::MacCapture,
	skylight,
};

pub(super) struct MacInput {
	source: CGEventSource,
}
#[allow(
	clippy::non_send_fields_in_send_ty,
	reason = "CGEventSource is an immutable CF object; `&mut self` receivers serialize all posting"
)]
// SAFETY: Core Graphics event sources are immutable CF objects after setup,
// and all access through `MacInput` requires `&mut self`, so events are posted
// serially after ownership moves between threads.
unsafe impl Send for MacInput {}

impl MacInput {
	pub(super) fn new() -> CoreResult<Self> {
		Ok(Self { source: source()? })
	}

	#[allow(
		clippy::needless_pass_by_ref_mut,
		reason = "`&mut self` exclusivity backs the `Send` safety argument for the CF event source"
	)]
	pub(super) fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<()> {
		match target {
			Target::Desktop => global_pointer(&self.source, event),
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						background_guard(&window, pointer_kind(&event), pointer_button(&event))?;
						if !window.focused {
							skylight::activate_without_raise(pid, wid)?;
						}
						background_pointer(&self.source, pid, wid, &window, event)
					},
					DeliveryMode::Foreground => {
						skylight::with_foreground(pid, wid, || global_pointer(&self.source, event))
					},
				}
			},
		}
	}

	#[allow(
		clippy::needless_pass_by_ref_mut,
		reason = "`&mut self` exclusivity backs the `Send` safety argument for the CF event source"
	)]
	pub(super) fn type_text(
		&mut self,
		target: &Target,
		text: &str,
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<()> {
		match target {
			Target::Desktop => global_type(&self.source, text),
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						background_guard(&window, "keyboard", None)?;
						prepare_background_keys(&window, pid, wid, capture)?;
						background_type(&self.source, pid, text)
					},
					DeliveryMode::Foreground => skylight::with_foreground(pid, wid, || {
						let _ = ax::prepare_foreground_input(&window);
						global_type(&self.source, text)
					}),
				}
			},
		}
	}

	#[allow(
		clippy::needless_pass_by_ref_mut,
		reason = "`&mut self` exclusivity backs the `Send` safety argument for the CF event source"
	)]
	pub(super) fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<()> {
		match target {
			Target::Desktop => global_chord(&self.source, keys),
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						background_guard(&window, "keyboard", None)?;
						prepare_background_keys(&window, pid, wid, capture)?;
						background_chord(&self.source, pid, keys)
					},
					DeliveryMode::Foreground => skylight::with_foreground(pid, wid, || {
						let _ = ax::prepare_foreground_input(&window);
						global_chord(&self.source, keys)
					}),
				}
			},
		}
	}
}

fn window_identity(window: &DesktopWindow) -> CoreResult<(libc::pid_t, u32)> {
	let pid = window.pid.ok_or_else(|| {
		DesktopError::input_failed(format!("window {} has no owning process id", window.id))
	})?;
	let pid = i32::try_from(pid).map_err(|_| {
		DesktopError::input_failed(format!("window {} has an invalid process id", window.id))
	})?;
	let wid = window.id.parse::<u32>().map_err(|_| {
		DesktopError::invalid_target(format!("invalid macOS window id '{}'", window.id))
	})?;
	Ok((pid, wid))
}

/// Prepares background keyboard delivery for `window`, or refuses it.
///
/// macOS posts key events to a *process*, which hands them to whichever window
/// it treats as key; unlike pointer events they carry no window id, and neither
/// the `SkyLight` focus records nor any accessibility attribute reliably
/// predicts or redirects that choice. Delivery is therefore refused whenever
/// the process owns more than one window, rather than typing into another of
/// the user's windows. `DesktopWindow::focused` cannot disambiguate: xcap
/// reports every window owned by the active application as focused on macOS.
///
/// The refusal decision itself reads no mutable state, so it cannot be fooled
/// by the activation below.
fn prepare_background_keys(
	window: &DesktopWindow,
	pid: libc::pid_t,
	wid: u32,
	capture: &MacCapture,
) -> CoreResult<()> {
	let siblings = capture
		.windows()?
		.into_iter()
		.filter(|candidate| candidate.pid == window.pid)
		.count();
	if siblings > 1 {
		return Err(DesktopError::background_unavailable(format!(
			"window {wid} is one of {siblings} windows in its application; macOS delivers background \
			 keystrokes to whichever window the application treats as key, so retry with \
			 delivery:\"foreground\" or use ax actions",
		)));
	}
	// Sole window of its process, so the target is unambiguous: make it key
	// without raising it or changing the frontmost application. A background app
	// otherwise has no key window and drops the keystrokes entirely.
	skylight::activate_without_raise(pid, wid)
}

const fn pointer_kind(event: &PointerEvent) -> &'static str {
	match event {
		PointerEvent::Click { .. } => "click",
		PointerEvent::Move { .. } => "pointer move",
		PointerEvent::Drag { .. } => "drag",
		PointerEvent::Scroll { .. } => "scroll",
	}
}

const fn pointer_button(event: &PointerEvent) -> Option<MouseButton> {
	match event {
		PointerEvent::Click { button, .. } | PointerEvent::Drag { button, .. } => Some(*button),
		PointerEvent::Move { .. } | PointerEvent::Scroll { .. } => None,
	}
}

fn background_guard(
	window: &DesktopWindow,
	kind: &str,
	button: Option<MouseButton>,
) -> CoreResult<()> {
	let app = window.app.to_ascii_lowercase();
	let chromium = ["chrome", "chromium", "electron", "brave", "edge", "arc"]
		.iter()
		.any(|name| app.contains(name));
	if chromium && button == Some(MouseButton::Right) {
		return Err(DesktopError::background_unavailable(format!(
			"window {} ({}) coerces synthetic background right-click events to left-clicks; retry \
			 with delivery:\"foreground\" or use ax actions",
			window.id, window.app,
		)));
	}
	let canvas_or_game = ["blender", "unity", "godot", "unreal", "ghost"]
		.iter()
		.any(|name| app.contains(name));
	if canvas_or_game {
		return Err(DesktopError::background_unavailable(format!(
			"window {} ({}) drops background {kind} events in its canvas/game input stack; retry \
			 with delivery:\"foreground\" or use ax actions",
			window.id, window.app,
		)));
	}
	Ok(())
}

const LOCAL_EVENT_FILTER: u32 = 0x01 | 0x02 | 0x04;
const SUPPRESSION_INTERVAL: u32 = 0;
const REMOTE_MOUSE_DRAG: u32 = 1;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
	#[link_name = "CGEventSourceSetLocalEventsSuppressionInterval"]
	fn set_local_events_suppression_interval(source: CGEventSourceRef, seconds: f64);
	#[link_name = "CGEventSourceSetLocalEventsFilterDuringSuppressionState"]
	fn set_local_events_filter_during_suppression_state(
		source: CGEventSourceRef,
		filter: u32,
		state: u32,
	);
	#[cfg(test)]
	#[link_name = "CGEventSourceGetLocalEventsSuppressionInterval"]
	fn get_local_events_suppression_interval(source: CGEventSourceRef) -> f64;
	#[cfg(test)]
	#[link_name = "CGEventSourceGetLocalEventsFilterDuringSuppressionState"]
	fn get_local_events_filter_during_suppression_state(source: CGEventSourceRef, state: u32)
	-> u32;
}

type TISInputSourceRef = *const c_void;
type CFDataRef = *const c_void;

const UNICODE_TEXT_CHUNK_UTF16_LEN: usize = 20;
const KEYBOARD_LAYOUT_KEYCODE_MAX: u16 = 127;
const MAX_LAYOUT_TRANSLATION_UNITS: usize = 8;
const UC_KEY_ACTION_DISPLAY: u16 = 3;
const UC_KEY_MODIFIER_NONE: u32 = 0x100;
const UC_KEY_MODIFIER_SHIFT: u32 = 0x20_102;
const UC_KEY_TRANSLATE_NO_DEAD_KEYS: u32 = 0;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
	// Each `Copy` function returns a +1 retained input source.
	#[link_name = "TISCopyCurrentKeyboardInputSource"]
	fn tis_copy_current_keyboard_input_source() -> TISInputSourceRef;
	#[link_name = "TISCopyCurrentKeyboardLayoutInputSource"]
	fn tis_copy_current_keyboard_layout_input_source() -> TISInputSourceRef;
	#[link_name = "TISCopyCurrentASCIICapableKeyboardLayoutInputSource"]
	fn tis_copy_current_ascii_capable_keyboard_layout_input_source() -> TISInputSourceRef;
	#[link_name = "kTISPropertyUnicodeKeyLayoutData"]
	static TIS_PROPERTY_UNICODE_KEY_LAYOUT_DATA: *const c_void;
	#[link_name = "TISGetInputSourceProperty"]
	fn tis_get_input_source_property(
		input_source: TISInputSourceRef,
		property: *const c_void,
	) -> CFDataRef;
	#[link_name = "UCKeyTranslate"]
	fn uc_key_translate(
		keyboard_layout: *const u8,
		virtual_key_code: u16,
		key_action: u16,
		modifier_key_state: u32,
		keyboard_type: u32,
		key_translate_options: u32,
		dead_key_state: *mut u32,
		max_string_length: isize,
		actual_string_length: *mut isize,
		unicode_string: *mut u16,
	) -> i32;
	#[link_name = "LMGetKbdType"]
	fn lm_get_kbd_type() -> u8;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
	#[link_name = "CFDataGetBytePtr"]
	fn cf_data_get_byte_ptr(data: CFDataRef) -> *const u8;
	#[link_name = "CFRelease"]
	fn cf_release(value: *const c_void);
}

/// A retained TIS input source keeps its borrowed Unicode layout data alive.
struct CurrentKeyboardLayout {
	input_source: TISInputSourceRef,
	bytes:        *const u8,
}

impl Drop for CurrentKeyboardLayout {
	fn drop(&mut self) {
		// SAFETY: every `CurrentKeyboardLayout` owns exactly one non-null +1
		// input source returned by a TIS copy function.
		unsafe { cf_release(self.input_source) };
	}
}

fn current_keyboard_layout() -> CoreResult<CurrentKeyboardLayout> {
	// SAFETY: each parameterless TIS copy function returns either a retained
	// input-source reference transferred to the helper or null.
	let current = unsafe { tis_copy_current_keyboard_input_source() };
	if let Some(layout) = keyboard_layout_from_source(current) {
		return Ok(layout);
	}
	// SAFETY: same retained-or-null ownership contract as above.
	let current_layout = unsafe { tis_copy_current_keyboard_layout_input_source() };
	if let Some(layout) = keyboard_layout_from_source(current_layout) {
		return Ok(layout);
	}
	// SAFETY: same retained-or-null ownership contract as above.
	let ascii_layout = unsafe { tis_copy_current_ascii_capable_keyboard_layout_input_source() };
	if let Some(layout) = keyboard_layout_from_source(ascii_layout) {
		return Ok(layout);
	}
	Err(DesktopError::input_failed(
		"current macOS keyboard input source does not expose Unicode layout data",
	))
}

fn keyboard_layout_from_source(input_source: TISInputSourceRef) -> Option<CurrentKeyboardLayout> {
	if input_source.is_null() {
		return None;
	}
	// SAFETY: `input_source` is a live +1 TIS source until this helper either
	// transfers it to `CurrentKeyboardLayout` or releases it below. The returned
	// CFData is borrowed from that source.
	let data =
		unsafe { tis_get_input_source_property(input_source, TIS_PROPERTY_UNICODE_KEY_LAYOUT_DATA) };
	if data.is_null() {
		// SAFETY: this rejected source still has its +1 copy ownership.
		unsafe { cf_release(input_source) };
		return None;
	}
	// SAFETY: `data` remains valid while its retained input source is live.
	let bytes = unsafe { cf_data_get_byte_ptr(data) };
	if bytes.is_null() {
		// SAFETY: this rejected source still has its +1 copy ownership.
		unsafe { cf_release(input_source) };
		return None;
	}
	Some(CurrentKeyboardLayout { input_source, bytes })
}

fn source() -> CoreResult<CGEventSource> {
	let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz input event source"))?;
	// SAFETY: `source` is a live CGEventSource and both setters accept these
	// documented masks/states.
	unsafe {
		set_local_events_suppression_interval(source.as_ptr(), 0.0);
		set_local_events_filter_during_suppression_state(
			source.as_ptr(),
			LOCAL_EVENT_FILTER,
			SUPPRESSION_INTERVAL,
		);
		set_local_events_filter_during_suppression_state(
			source.as_ptr(),
			LOCAL_EVENT_FILTER,
			REMOTE_MOUSE_DRAG,
		);
	}
	Ok(source)
}

fn modifier_flags(modifiers: Modifiers) -> CGEventFlags {
	let mut flags = CGEventFlags::CGEventFlagNull;
	if modifiers.ctrl {
		flags |= CGEventFlags::CGEventFlagControl;
	}
	if modifiers.alt {
		flags |= CGEventFlags::CGEventFlagAlternate;
	}
	if modifiers.shift {
		flags |= CGEventFlags::CGEventFlagShift;
	}
	if modifiers.meta {
		flags |= CGEventFlags::CGEventFlagCommand;
	}
	flags
}

const fn button_types(
	button: MouseButton,
) -> (CGMouseButton, CGEventType, CGEventType, CGEventType, i64) {
	match button {
		MouseButton::Left => (
			CGMouseButton::Left,
			CGEventType::LeftMouseDown,
			CGEventType::LeftMouseUp,
			CGEventType::LeftMouseDragged,
			0,
		),
		MouseButton::Right => (
			CGMouseButton::Right,
			CGEventType::RightMouseDown,
			CGEventType::RightMouseUp,
			CGEventType::RightMouseDragged,
			1,
		),
		MouseButton::Middle => (
			CGMouseButton::Center,
			CGEventType::OtherMouseDown,
			CGEventType::OtherMouseUp,
			CGEventType::OtherMouseDragged,
			2,
		),
	}
}

fn background_pointer(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	event: PointerEvent,
) -> CoreResult<()> {
	match event {
		PointerEvent::Click { x, y, button, count, modifiers } => {
			background_click(source, pid, wid, window, x, y, button, count, modifiers)
		},
		PointerEvent::Move { x, y } => {
			let group = click_group_id();
			post_mouse(
				pid,
				wid,
				window,
				source.clone(),
				CGEventType::MouseMoved,
				CGMouseButton::Left,
				x,
				y,
				2,
				0,
				0,
				group,
				CGEventFlags::CGEventFlagNull,
			)
		},
		PointerEvent::Drag { path, button, modifiers } => {
			background_drag(source, pid, wid, window, &path, button, modifiers)
		},
		PointerEvent::Scroll { x, y, dx, dy } => {
			background_scroll(source, pid, wid, window, x, y, dx, dy)
		},
	}
}

fn background_click(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	x: f64,
	y: f64,
	button: MouseButton,
	count: u32,
	modifiers: Modifiers,
) -> CoreResult<()> {
	let group = click_group_id();
	let (cg_button, down, up, _, number) = button_types(button);
	let flags = modifier_flags(modifiers);
	pointer_prologue(pid, wid, window, source, x, y, group, flags)?;
	for click_state in 1..=count.max(1) {
		post_mouse(
			pid,
			wid,
			window,
			source.clone(),
			down,
			cg_button,
			x,
			y,
			3,
			i64::from(click_state),
			number,
			group,
			flags,
		)?;
		thread::sleep(Duration::from_millis(1));
		post_mouse(
			pid,
			wid,
			window,
			source.clone(),
			up,
			cg_button,
			x,
			y,
			3,
			i64::from(click_state),
			number,
			group,
			flags,
		)?;
		if click_state < count.max(1) {
			thread::sleep(Duration::from_millis(80));
		}
	}
	Ok(())
}

fn pointer_prologue(
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	source: &CGEventSource,
	x: f64,
	y: f64,
	group: i64,
	flags: CGEventFlags,
) -> CoreResult<()> {
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		CGEventType::MouseMoved,
		CGMouseButton::Left,
		x,
		y,
		2,
		0,
		0,
		group,
		flags,
	)?;
	thread::sleep(Duration::from_millis(15));
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		CGEventType::LeftMouseDown,
		CGMouseButton::Left,
		-1.0,
		-1.0,
		1,
		1,
		0,
		group,
		flags,
	)?;
	thread::sleep(Duration::from_millis(1));
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		CGEventType::LeftMouseUp,
		CGMouseButton::Left,
		-1.0,
		-1.0,
		2,
		1,
		0,
		group,
		flags,
	)?;
	thread::sleep(Duration::from_millis(100));
	Ok(())
}

fn background_drag(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	path: &[(f64, f64)],
	button: MouseButton,
	modifiers: Modifiers,
) -> CoreResult<()> {
	let Some(&(start_x, start_y)) = path.first() else {
		return Err(DesktopError::input_failed("drag path must contain at least two points"));
	};
	if path.len() < 2 {
		return Err(DesktopError::input_failed("drag path must contain at least two points"));
	}
	let group = click_group_id();
	let (cg_button, down, up, dragged, number) = button_types(button);
	let flags = modifier_flags(modifiers);
	pointer_prologue(pid, wid, window, source, start_x, start_y, group, flags)?;
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		down,
		cg_button,
		start_x,
		start_y,
		3,
		1,
		number,
		group,
		flags,
	)?;
	for &(x, y) in &path[1..] {
		thread::sleep(Duration::from_millis(16));
		post_mouse(
			pid,
			wid,
			window,
			source.clone(),
			dragged,
			cg_button,
			x,
			y,
			3,
			1,
			number,
			group,
			flags,
		)?;
	}
	thread::sleep(Duration::from_millis(50));
	let &(end_x, end_y) = path
		.last()
		.ok_or_else(|| DesktopError::input_failed("drag path is empty"))?;
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		up,
		cg_button,
		end_x,
		end_y,
		3,
		1,
		number,
		group,
		flags,
	)?;
	Ok(())
}

#[allow(
	clippy::too_many_arguments,
	reason = "the parameters are the native CGEvent fields stamped together"
)]
fn post_mouse(
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	source: CGEventSource,
	event_type: CGEventType,
	button: CGMouseButton,
	x: f64,
	y: f64,
	phase: i64,
	click_state: i64,
	button_number: i64,
	click_group: i64,
	flags: CGEventFlags,
) -> CoreResult<()> {
	let event = CGEvent::new_mouse_event(source, event_type, CGPoint::new(x, y), button)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz pointer event"))?;
	// Flags are exactly the caller-requested modifier set; no background bypass
	// modifier is injected.
	event.set_flags(flags);
	let local = if x == -1.0 && y == -1.0 {
		CGPoint::new(-1.0, -1.0)
	} else {
		CGPoint::new(x - f64::from(window.x), y - f64::from(window.y))
	};
	skylight::stamp_event(&event, pid, wid, local, phase, click_state, button_number, click_group)?;
	skylight::post_dual(pid, &event)
}

fn background_scroll(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	x: f64,
	y: f64,
	dx: f64,
	dy: f64,
) -> CoreResult<()> {
	let group = click_group_id();
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		CGEventType::MouseMoved,
		CGMouseButton::Left,
		x,
		y,
		2,
		0,
		0,
		group,
		CGEventFlags::CGEventFlagNull,
	)?;
	thread::sleep(Duration::from_millis(15));
	let wheel_x = finite_i32(dx, "horizontal scroll delta")?;
	let wheel_y = finite_i32(dy, "vertical scroll delta")?;
	let event =
		CGEvent::new_scroll_event(source.clone(), ScrollEventUnit::PIXEL, 2, wheel_y, wheel_x, 0)
			.map_err(|()| DesktopError::input_failed("failed to create a Quartz scroll event"))?;
	event.set_location(CGPoint::new(x, y));
	skylight::stamp_event(
		&event,
		pid,
		wid,
		CGPoint::new(x - f64::from(window.x), y - f64::from(window.y)),
		3,
		0,
		0,
		group,
	)?;
	skylight::post_dual(pid, &event)
}

fn click_group_id() -> i64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.subsec_nanos()
		.into()
}

fn background_type(source: &CGEventSource, pid: libc::pid_t, text: &str) -> CoreResult<()> {
	type_text(source, text, |event| skylight::post_keyboard(pid, event))
}

fn global_type(source: &CGEventSource, text: &str) -> CoreResult<()> {
	type_text(source, text, post_global)
}

fn type_text(
	source: &CGEventSource,
	text: &str,
	mut post: impl FnMut(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	let mut remaining = text;
	while !remaining.is_empty() {
		let end = unicode_text_chunk_end(remaining);
		debug_assert!(end > 0);
		let mut chunk = &remaining[..end];
		remaining = &remaining[end..];
		// CGEventKeyboardSetUnicodeString silently drops a chunk that begins
		// with these controls. Preserve controls inside a Unicode chunk exactly;
		// only repair a leading control as Enigo's macOS helper does.
		while let Some(character) = chunk.chars().next() {
			let character_end = character.len_utf8();
			match character {
				'\t' => {
					post_text_key(source, KeyName::Tab, &mut post)?;
					chunk = &chunk[character_end..];
				},
				'\r' | '\n' => {
					let value = if character == '\r' {
						"\u{200B}\r"
					} else {
						"\u{200B}\n"
					};
					post_unicode_text(source, value, &mut post)?;
					chunk = &chunk[character_end..];
				},
				_ => break,
			}
		}
		if !chunk.is_empty() {
			post_unicode_text(source, chunk, &mut post)?;
		}
	}
	Ok(())
}

fn unicode_text_chunk_end(text: &str) -> usize {
	let mut utf16_len = 0;
	let mut end = 0;
	for (index, character) in text.char_indices() {
		let character_utf16_len = character.len_utf16();
		if utf16_len + character_utf16_len > UNICODE_TEXT_CHUNK_UTF16_LEN {
			break;
		}
		utf16_len += character_utf16_len;
		end = index + character.len_utf8();
	}
	end
}

fn post_unicode_text(
	source: &CGEventSource,
	text: &str,
	post: &mut impl FnMut(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	debug_assert!(!text.is_empty());
	let event = CGEvent::new_keyboard_event(source.clone(), 0, true)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz keyboard event"))?;
	event.set_string(text);
	event.set_flags(CGEventFlags::CGEventFlagNull);
	post(&event)
}

fn post_text_key(
	source: &CGEventSource,
	key: KeyName,
	post: &mut impl FnMut(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	let code = key_code(key)?;
	for down in [true, false] {
		post_key_code(source, code, down, CGEventFlags::CGEventFlagNull, post)?;
	}
	Ok(())
}

fn background_chord(source: &CGEventSource, pid: libc::pid_t, keys: &[KeyName]) -> CoreResult<()> {
	key_chord(source, keys, |event| skylight::post_keyboard(pid, event))
}

fn global_chord(source: &CGEventSource, keys: &[KeyName]) -> CoreResult<()> {
	key_chord(source, keys, post_global)
}

fn key_chord(
	source: &CGEventSource,
	keys: &[KeyName],
	mut post: impl FnMut(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	if keys.is_empty() {
		return Err(DesktopError::invalid_key("key chord must not be empty"));
	}
	let mut active = Modifiers::default();
	let mut pressed = Vec::with_capacity(keys.len());
	for &key in keys {
		let code = match key_code(key) {
			Ok(code) => code,
			Err(error) => {
				release_chord(source, &mut active, &pressed, &mut post);
				return Err(error);
			},
		};
		update_modifier(&mut active, key, true);
		if let Err(error) = post_key_code(source, code, true, modifier_flags(active), &mut post) {
			// The failed key was never added to `pressed`, so remove its modifier
			// state before releasing only the keys that did go down.
			update_modifier(&mut active, key, false);
			release_chord(source, &mut active, &pressed, &mut post);
			return Err(error);
		}
		pressed.push((key, code));
		thread::sleep(Duration::from_millis(8));
	}
	let mut first_error = None;
	for &(key, code) in pressed.iter().rev() {
		update_modifier(&mut active, key, false);
		if let Err(error) = post_key_code(source, code, false, modifier_flags(active), &mut post)
			&& first_error.is_none()
		{
			first_error = Some(error);
		}
		thread::sleep(Duration::from_millis(8));
	}
	first_error.map_or(Ok(()), Err)
}

fn release_chord(
	source: &CGEventSource,
	active: &mut Modifiers,
	pressed: &[(KeyName, u16)],
	post: &mut impl FnMut(&CGEvent) -> CoreResult<()>,
) {
	for &(key, code) in pressed.iter().rev() {
		update_modifier(active, key, false);
		let _ = post_key_code(source, code, false, modifier_flags(*active), post);
		thread::sleep(Duration::from_millis(8));
	}
}

fn post_key_code(
	source: &CGEventSource,
	code: u16,
	down: bool,
	flags: CGEventFlags,
	post: &mut impl FnMut(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	let event = CGEvent::new_keyboard_event(source.clone(), code, down)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz keyboard event"))?;
	event.set_flags(flags);
	post(&event)
}

const fn update_modifier(modifiers: &mut Modifiers, key: KeyName, down: bool) {
	match key {
		KeyName::Ctrl => modifiers.ctrl = down,
		KeyName::Alt => modifiers.alt = down,
		KeyName::Shift => modifiers.shift = down,
		KeyName::Meta => modifiers.meta = down,
		_ => {},
	}
}

fn key_code(key: KeyName) -> CoreResult<u16> {
	let code = match key {
		KeyName::Ctrl => 59,
		KeyName::Alt => 58,
		KeyName::Shift => 56,
		KeyName::Meta => 55,
		KeyName::Enter => 36,
		KeyName::Escape => 53,
		KeyName::Tab => 48,
		KeyName::Space => 49,
		KeyName::Backspace => 51,
		KeyName::Delete => 117,
		KeyName::Insert => 114,
		KeyName::Home => 115,
		KeyName::End => 119,
		KeyName::PageUp => 116,
		KeyName::PageDown => 121,
		KeyName::Up => 126,
		KeyName::Down => 125,
		KeyName::Left => 123,
		KeyName::Right => 124,
		KeyName::CapsLock => 57,
		KeyName::NumLock => 71,
		KeyName::PrintScreen => 105,
		KeyName::F1 => 122,
		KeyName::F2 => 120,
		KeyName::F3 => 99,
		KeyName::F4 => 118,
		KeyName::F5 => 96,
		KeyName::F6 => 97,
		KeyName::F7 => 98,
		KeyName::F8 => 100,
		KeyName::F9 => 101,
		KeyName::F10 => 109,
		KeyName::F11 => 103,
		KeyName::F12 => 111,
		KeyName::F13 => 105,
		KeyName::F14 => 107,
		KeyName::F15 => 113,
		KeyName::F16 => 106,
		KeyName::F17 => 64,
		KeyName::F18 => 79,
		KeyName::F19 => 80,
		KeyName::F20 => 90,
		KeyName::F21 => 110,
		KeyName::F22 => 111,
		KeyName::F23 => 112,
		KeyName::F24 => 113,
		KeyName::Char(character) => char_key_code(character)?,
	};
	Ok(code)
}

fn char_key_code(character: char) -> CoreResult<u16> {
	let layout = current_keyboard_layout()?;
	let mut expected = [0u16; 2];
	let expected_len = character.encode_utf16(&mut expected).len();
	for code in 0..=KEYBOARD_LAYOUT_KEYCODE_MAX {
		if layout_key_translates_to(&layout, code, UC_KEY_MODIFIER_NONE, &expected[..expected_len])
			|| layout_key_translates_to(
				&layout,
				code,
				UC_KEY_MODIFIER_SHIFT,
				&expected[..expected_len],
			) {
			return Ok(code);
		}
	}
	Err(DesktopError::invalid_key(format!(
		"key '{character}' has no virtual keycode in the active macOS keyboard layout"
	)))
}

fn layout_key_translates_to(
	layout: &CurrentKeyboardLayout,
	code: u16,
	modifiers: u32,
	expected: &[u16],
) -> bool {
	let mut dead_key_state = 0;
	let mut translated = [0u16; MAX_LAYOUT_TRANSLATION_UNITS];
	let mut translated_len = 0;
	// SAFETY: `layout.bytes` is borrowed from the retained TIS source in
	// `layout`; all output pointers reference initialized writable stack storage.
	let status = unsafe {
		uc_key_translate(
			layout.bytes,
			code,
			UC_KEY_ACTION_DISPLAY,
			modifiers,
			u32::from(lm_get_kbd_type()),
			UC_KEY_TRANSLATE_NO_DEAD_KEYS,
			&mut dead_key_state,
			translated.len() as isize,
			&mut translated_len,
			translated.as_mut_ptr(),
		)
	};
	if status != 0 {
		return false;
	}
	let Ok(translated_len) = usize::try_from(translated_len) else {
		return false;
	};
	translated.get(..translated_len) == Some(expected)
}

fn global_pointer(source: &CGEventSource, event: PointerEvent) -> CoreResult<()> {
	match event {
		PointerEvent::Click { x, y, button, count, modifiers } => {
			post_global_mouse(
				source,
				CGEventType::MouseMoved,
				CGMouseButton::Left,
				x,
				y,
				0,
				0,
				CGEventFlags::CGEventFlagNull,
			)?;
			let (cg_button, down, up, _, number) = button_types(button);
			let flags = modifier_flags(modifiers);
			for click_state in 1..=count.max(1) {
				post_global_mouse(
					source,
					down,
					cg_button,
					x,
					y,
					i64::from(click_state),
					number,
					flags,
				)?;
				thread::sleep(Duration::from_millis(1));
				post_global_mouse(source, up, cg_button, x, y, i64::from(click_state), number, flags)?;
				if click_state < count.max(1) {
					thread::sleep(Duration::from_millis(80));
				}
			}
			Ok(())
		},
		PointerEvent::Move { x, y } => post_global_mouse(
			source,
			CGEventType::MouseMoved,
			CGMouseButton::Left,
			x,
			y,
			0,
			0,
			CGEventFlags::CGEventFlagNull,
		),
		PointerEvent::Drag { path, button, modifiers } => {
			let Some(&(start_x, start_y)) = path.first() else {
				return Err(DesktopError::input_failed("drag path must contain at least two points"));
			};
			if path.len() < 2 {
				return Err(DesktopError::input_failed("drag path must contain at least two points"));
			}
			let (cg_button, down, up, dragged, number) = button_types(button);
			let flags = modifier_flags(modifiers);
			post_global_mouse(
				source,
				CGEventType::MouseMoved,
				CGMouseButton::Left,
				start_x,
				start_y,
				0,
				0,
				CGEventFlags::CGEventFlagNull,
			)?;
			post_global_mouse(source, down, cg_button, start_x, start_y, 1, number, flags)?;
			for &(x, y) in &path[1..] {
				thread::sleep(Duration::from_millis(16));
				post_global_mouse(source, dragged, cg_button, x, y, 1, number, flags)?;
			}
			thread::sleep(Duration::from_millis(50));
			let &(end_x, end_y) = path
				.last()
				.ok_or_else(|| DesktopError::input_failed("drag path is empty"))?;
			post_global_mouse(source, up, cg_button, end_x, end_y, 1, number, flags)
		},
		PointerEvent::Scroll { x, y, dx, dy } => global_scroll(source, x, y, dx, dy),
	}
}

fn global_scroll(source: &CGEventSource, x: f64, y: f64, dx: f64, dy: f64) -> CoreResult<()> {
	post_global_mouse(
		source,
		CGEventType::MouseMoved,
		CGMouseButton::Left,
		x,
		y,
		0,
		0,
		CGEventFlags::CGEventFlagNull,
	)?;
	let wheel_x = quartz_scroll_delta(dx, "horizontal scroll delta")?;
	let wheel_y = quartz_scroll_delta(dy, "vertical scroll delta")?;
	let location = point(x, y)?;
	// Match the former Enigo path: positive API deltas mean down/right, while
	// Quartz wheel axes use the inverse sign. It also emitted separate legacy
	// line-unit events for horizontal and vertical movement.
	if wheel_x != 0 {
		post_global_scroll(source, location, 2, 0, wheel_x)?;
	}
	if wheel_y != 0 {
		post_global_scroll(source, location, 1, wheel_y, 0)?;
	}
	Ok(())
}

fn post_global_scroll(
	source: &CGEventSource,
	location: CGPoint,
	wheel_count: u32,
	wheel1: i32,
	wheel2: i32,
) -> CoreResult<()> {
	let event = CGEvent::new_scroll_event(
		source.clone(),
		ScrollEventUnit::LINE,
		wheel_count,
		wheel1,
		wheel2,
		0,
	)
	.map_err(|()| DesktopError::input_failed("failed to create a Quartz scroll event"))?;
	event.set_location(location);
	post_global(&event)
}

#[allow(
	clippy::too_many_arguments,
	reason = "the parameters are the native CGEvent fields stamped together"
)]
fn post_global_mouse(
	source: &CGEventSource,
	event_type: CGEventType,
	button: CGMouseButton,
	x: f64,
	y: f64,
	click_state: i64,
	button_number: i64,
	flags: CGEventFlags,
) -> CoreResult<()> {
	let event = CGEvent::new_mouse_event(source.clone(), event_type, point(x, y)?, button)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz pointer event"))?;
	event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click_state);
	if button_number != 0 {
		event.set_integer_value_field(EventField::MOUSE_EVENT_BUTTON_NUMBER, button_number);
	}
	event.set_flags(flags);
	post_global(&event)
}

#[allow(
	clippy::unnecessary_wraps,
	reason = "matches the fallible `FnMut(&CGEvent) -> CoreResult<()>` post callback used by \
	          background posting"
)]
fn post_global(event: &CGEvent) -> CoreResult<()> {
	event.post(CGEventTapLocation::HID);
	Ok(())
}

fn point(x: f64, y: f64) -> CoreResult<CGPoint> {
	Ok(CGPoint::new(
		f64::from(finite_i32(x, "x coordinate")?),
		f64::from(finite_i32(y, "y coordinate")?),
	))
}

fn finite_i32(value: f64, name: &str) -> CoreResult<i32> {
	if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
		return Err(DesktopError::input_failed(format!(
			"{name} {value} is outside the macOS input range"
		)));
	}
	Ok(value.round() as i32)
}

fn quartz_scroll_delta(value: f64, name: &str) -> CoreResult<i32> {
	finite_i32(value, name)?.checked_neg().ok_or_else(|| {
		DesktopError::input_failed(format!(
			"{name} {value} cannot be represented as a Quartz scroll delta"
		))
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn event_source_never_suppresses_local_input() {
		let source = source().expect("Quartz event source");
		// SAFETY: `source` remains live for both CoreGraphics getter calls.
		unsafe {
			assert_eq!(get_local_events_suppression_interval(source.as_ptr()), 0.0);
			assert_eq!(
				get_local_events_filter_during_suppression_state(source.as_ptr(), SUPPRESSION_INTERVAL,),
				LOCAL_EVENT_FILTER,
			);
			assert_eq!(
				get_local_events_filter_during_suppression_state(source.as_ptr(), REMOTE_MOUSE_DRAG,),
				LOCAL_EVENT_FILTER,
			);
		}
	}
}
