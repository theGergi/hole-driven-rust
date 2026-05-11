// This test case tests Rust borrowing rules, including immutable and mutable borrows,
// and how they affect variable suggestions in holes.
// Key rules: Multiple immutable borrows allowed, but mutable borrows are exclusive.
// A mutable borrow prevents other borrows, and vice versa.

fn immutable_borrow(s: &str) {
	// We can read the value
	println!("I'm reading: {}", s);
}

fn mutable_borrow(s: &mut str) {
	// We can change the value
	// s.push_str("... modified!");
	println!("Updated: {}", s);
}
	
fn main() {
	let mut s = "hello";
		
	let s_imm_borrow: &str = &s; // Immutable borrow created

	immutable_borrow(??); // expects 's_imm_borrow', '&s' - can create another imm borrow or use existing
		
	let s_imm_borrow_2: &str = ??; // expects 's_imm_borrow', '&s' - still can borrow imm

	immutable_borrow(??); // expects 's_imm_borrow', '&s' - multiple imm borrows ok
		
	let s_mut_borrow: &mut str = ??; // expects '&mut s' - can create mut borrow since no other borrows active

	mutable_borrow(??);   // expects '&mut s' - mut borrow still active

	{
		let s_mut_borrow_2: &mut str = ??; // expects [] - s_imm_borrow used later, can't create mut borrow

		mutable_borrow(??);   // expects [] - same reason, conflict with future imm borrow

		immutable_borrow(s_imm_borrow); // Uses the imm borrow
	}

	let s_mut_borrow_3: &mut str = ??; // expects '&mut s' - imm borrow scope ended, can borrow mut

	mutable_borrow(??);   // expects '&mut s' - mut borrow active
}