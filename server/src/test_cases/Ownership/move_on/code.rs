// Ownership on (the default): `a` is moved into `owner` and must not be suggested.
// The paired case Ownership/move_off runs this same program with ownership switched off.

struct Widget {
    id: i32,
}

fn main() {
    let a = Widget { id: 1 };
    let b = Widget { id: 2 };
    let owner = a;
    let w: Widget = ??;
}
