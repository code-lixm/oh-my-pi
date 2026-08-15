//! Deterministic row-plan calculation for the TUI compositor shadow path.
//!
//! This module is intentionally side-effect free. It does not render terminal
//! escape sequences and it never owns compositor state; TypeScript remains the
//! authority for frame, scrollback, image, and cursor state.

use napi_derive::napi;

#[napi(object)]
pub struct TerminalRowPlan {
	pub previous_len:  u32,
	pub next_len:      u32,
	pub first_changed: Option<u32>,
	pub last_changed:  Option<u32>,
	pub changed_rows:  u32,
	pub same:          bool,
}

#[napi]
pub fn terminal_row_plan(previous: Vec<String>, next: Vec<String>) -> TerminalRowPlan {
	let common = previous.len().min(next.len());
	let mut first_changed = None;
	let mut last_changed = None;
	let mut changed_rows: u32 = 0;

	for index in 0..common {
		if previous[index] == next[index] {
			continue;
		}
		let index = index as u32;
		first_changed.get_or_insert(index);
		last_changed = Some(index);
		changed_rows = changed_rows.saturating_add(1);
	}

	if previous.len() != next.len() {
		let start = common as u32;
		let end = next.len().max(previous.len()) as u32 - 1;
		first_changed.get_or_insert(start);
		last_changed = Some(end);
		changed_rows = changed_rows.saturating_add((end - start).saturating_add(1));
	}

	TerminalRowPlan {
		previous_len: previous.len().min(u32::MAX as usize) as u32,
		next_len: next.len().min(u32::MAX as usize) as u32,
		first_changed,
		last_changed,
		changed_rows,
		same: first_changed.is_none(),
	}
}

#[cfg(test)]
mod tests {
	use super::terminal_row_plan;

	#[test]
	fn plans_changed_middle_rows_without_mutating_inputs() {
		let previous = vec!["a".into(), "b".into(), "c".into()];
		let next = vec!["a".into(), "B".into(), "c".into()];
		let plan = terminal_row_plan(previous.clone(), next.clone());

		assert_eq!(plan.previous_len, 3);
		assert_eq!(plan.next_len, 3);
		assert_eq!(plan.first_changed, Some(1));
		assert_eq!(plan.last_changed, Some(1));
		assert_eq!(plan.changed_rows, 1);
		assert!(!plan.same);
		assert_eq!(previous, vec!["a", "b", "c"]);
		assert_eq!(next, vec!["a", "B", "c"]);
	}

	#[test]
	fn plans_appended_rows_and_empty_frames() {
		let appended = terminal_row_plan(vec!["a".into()], vec!["a".into(), "b".into(), "c".into()]);
		assert_eq!(appended.first_changed, Some(1));
		assert_eq!(appended.last_changed, Some(2));
		assert_eq!(appended.changed_rows, 2);

		let empty = terminal_row_plan(Vec::new(), Vec::new());
		assert!(empty.same);
		assert_eq!(empty.changed_rows, 0);
	}
}
