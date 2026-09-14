fn custom_max(a: integer, b: integer) -> integer {
    if a > b { a } else { b }
}

fn custom_min(a: integer, b: integer) -> integer {
    if a < b { a } else { b }
}

fn evaluate(board: &Vec<&str>) -> integer {
    let win_patterns = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
        [0, 3, 6], [1, 4, 7], [2, 5, 8], // Cols
        [0, 4, 8], [2, 4, 6],           // Diagonals
    ];

    for p in win_patterns {
        if board[p[0]] != "." && board[p[0]] == board[p[1]] && board[p[0]] == board[p[2]] {
            // Return 10 for 'x' win, -10 for 'o' win
            return if board[p[0]] == "x" { 10 } else { -10 };
        }
    }
    0
}

fn minimax(board: &mut Vec<&str>, depth: integer, is_maximizing: bool) -> integer {
    let score = evaluate(board);

    // Terminal states
    if score == 10 { return score - depth; }
    if score == -10 { return score + depth; }
    if !board.contains(&".") { return 0; }

    if is_maximizing {
        let mut best = -1000;
        for i in 0..9 {
            if board[i] == "." {
                board[i] = "x";
                let val = minimax(board, depth + 1, false);
                best = custom_max(best, val);
                board[i] = "."; // Backtrack
            }
        }
        best
    } else {
        let mut best = 1000;
        for i in 0..9 {
            if board[i] == "." {
                board[i] = "o";
                let val = minimax(board, depth + 1, true);
                best = custom_min(best, val);
                board[i] = "."; // Backtrack
            }
        }
        best
    }
}

fn main() {
    let mut board = vec![
        "x", "x", ".",
        "o", "o", ".",
        ".", ".", ".",
    ];
    ??
    let result: integer = minimax(&mut board, 0, true);
    println!("Best score: {}", result);
}