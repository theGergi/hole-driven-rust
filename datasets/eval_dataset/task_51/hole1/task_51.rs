
use std::{slice::Iter, cmp::{max, self}, mem::replace, collections::{HashSet, HashMap}, ops::Index, ascii::AsciiExt};
use rand::Rng;
use regex::Regex;
use md5;
use std::any::{Any, TypeId};

fn remove_vowels(text: &str) -> String {


    let vowels = "AEIOUaeiou";
    let mut out = ??;
    for c in text.chars() {
        if !vowels.contains(c) {
            out.push(c);
        }
    }
    out
}
