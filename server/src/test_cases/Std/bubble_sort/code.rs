use std::cmp::Ord;
use std::vec::Vec;

fn bubble_sort<T: Ord>(arr: &mut Vec<i32>) {
    let mut len = arr.len();
    let mut swapped = true;

    let x: Vec<i32> = ??;

    while swapped {
        swapped = false;
        for i in 1..len {
            if arr[i - 1] > arr[i] {
                arr.swap(i - 1, i);
                swapped = true;
            }
        }
        len -= 1;
    }
}

fn main() {
    // Creating a vector using Vec::new() and pushing elements, 
    // just to show the Vec type explicitly without the vec! macro shortcut
    let mut numbers: Vec<i32> = Vec::from([64, 34, 25, 12, 22, 11, 90]);
    
    println!("Before: {:?}", numbers);
    bubble_sort(&mut numbers);
    println!("After:  {:?}", numbers);
}