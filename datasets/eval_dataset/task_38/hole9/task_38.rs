
use std::{slice::Iter, cmp::{max, self}, mem::replace, collections::{HashSet, HashMap}, ops::Index, ascii::AsciiExt};
use rand::Rng;
use regex::Regex;
use md5;
use std::any::{Any, TypeId};

fn encode_cyclic(s: &str) -> String {


    let mut even = vec![];
    let mut out:Vec<i32> = vec![];

    for (indx,elem) in nmbs.iter().enumerate(){
        if indx%2 == 0{
            even.push(elem)
        }
    }
    even.sort();
    let mut indx_t:usize = 0;

    for i in ?? {
        if i%2 == 0{
            if indx_t < even.len(){
                out.push(*even[indx_t]);
                indx_t += 1;
        }
        }else{
            out.push(nmbs[i]);
        }
        
    }
    return out;
}


//HumanEval/38 string decode_cyclic(string s){
pub fn encode_cyclic(s: &str) -> String {
    // returns encoded string by cycling groups of three characters. 
    // split string to groups. Each of length 3.
    let l = s.len();
    let num = (l + 2) / 3;
    let mut output = String::new();
    for i in 0..num {
        let group = &s[i * 3..std::cmp::min(l, (i + 1) * 3)];
        // cycle elements in each group. Unless group has fewer elements than 3.
        if group.len() == 3 {
            let x = format!("{}{}{}", &group[1..2], &group[2..3], &group[0..1]);
            output.push_str(&x);
        } else {
            output.push_str(group);
        }
    }
    output
}

pub fn decode_cyclic(s: &str) -> String {
    let l = s.len();
    let num = (l + 2) / 3;
    let mut output = String::new();
    for i in 0..num {
        let group = &s[i * 3..std::cmp::min(l, (i + 1) * 3)];
        // revert the cycle performed by the encode_cyclic function
        if group.len() == 3 {
            let x = format!("{}{}{}", &group[2..3], &group[0..1], &group[1..2]);
            output.push_str(&x);
        } else {
            output.push_str(group);
        }
    }
    output
}
