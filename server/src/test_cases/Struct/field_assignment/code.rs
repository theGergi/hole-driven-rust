// Assigning to a struct field `p.x = ??` should offer i32-typed values,
// including the sibling field `p.y`.

struct Point {
    x: i32,
    y: i32,
}

fn main() {
    let a: i32 = 5;
    let mut p = Point { x: 1, y: 2 };
    p.x = ??;
}
