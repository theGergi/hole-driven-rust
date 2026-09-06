// Ownership off: the same program as Ownership/move_on, but with move tracking disabled `a`
// is never marked consumed, so it comes back as a suggestion alongside `b` and `owner`.

struct Widget {
    id: i32,
}

fn main() {
    let a = Widget { id: 1 };
    let b = Widget { id: 2 };
    let owner = a;
    let w: Widget = ??;
}
