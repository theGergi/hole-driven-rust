// Ownership on (the default). `r` and `r2` both borrow `s`. Offering `r` at the hole means
// holding two live borrows at once, and `r2` is used after the hole, so `r` is filtered out
// while `r2` (whose only rival, `r`, is dead by then) survives.
//
// This is the checkBorrows liveness path: `r` carries no borrows/consumed flag of its own, it is
// rejected purely through the owner link back to `s`. Paired with Ownership/live_borrow_off.

fn immutable_borrow(s: &String) {}

fn main() {
	let s = String::from("hello");
	let r: &String = &s;
	let r2: &String = &s;

	immutable_borrow(??);

	immutable_borrow(r2);
}
