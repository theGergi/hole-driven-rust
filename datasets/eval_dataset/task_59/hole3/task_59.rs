
use std::{slice::Iter, cmp::{max, self}, mem::replace, collections::{HashSet, HashMap}, ops::Index, ascii::AsciiExt};
use rand::Rng;
use regex::Regex;
use md5;
use std::any::{Any, TypeId};

fn largest_prime_factor(n:i32) -> i32{


    let mut n1 = n.clone();
    for i in ??{
        while n1%i == 0 && n1>i{n1 = n1/i;}
    }
    return n1;
}
