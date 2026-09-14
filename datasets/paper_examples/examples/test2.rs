pub struct Vec<T> {
}

impl<T> Vec<T> {
    pub fn new() -> Self {}

    pub fn len(&self, a: integer) -> integer {}

    pub fn extend_from_slice(&mut self, other: &Vec<T>) {}
}

struct Buffer {
    data: Vec<integer>,
    capacity: integer,
}

fn min(a: integer, b: integer) -> integer {}

fn write_chunk(dst: &mut Buffer, src: Vec<integer>) -> integer {
    let space = dst.capacity - dst.data.len();
    let amt   = min(space, src.len());
    dst.data.extend_from_slice(&src[..amt]);
    amt
}

fn main() {
    let mut buf = Buffer { data: vec![0; 64], capacity: 64 };

    let r1: &Buffer     = &buf;        // shared borrow
    let r2: &Buffer     = &buf;        // second shared borrow (allowed)

    let mut second_buffer = Buffer { data: vec![0; 64], capacity: 64 };

    let n = write_chunk(??, ??);
    
    println!("wrote {n} bytes");
}

