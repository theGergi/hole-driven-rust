# toy-language-extension

Rust hole-completion tool (VS Code language server) plus an evaluation pipeline that
compares it against rust-analyzer on holes punched into HumanEval-Rust tasks.

## Prerequisites

- Node.js + npm
- Python 3
- Rust via `rustup` (the scraper pins a nightly toolchain with `rustc-dev`; rustup installs it automatically)
- rust-analyzer (only for `evaluateRa`) — picked up from the VS Code extension, `$RA_BIN`, or `PATH`

## Setup

```sh
npm install        # installs root, client, server and shared workspaces
npm run compile
```

## Running the extension

1. Open the repo root in VS Code and run `npm run watch` (recompiles on save).
2. In the **Run and Debug** sidebar, pick **Launch Client** and press ▶ (or `F5`).
3. In the Extension Development Host window that opens, open any `.rs` file
   (e.g. from `server/src/test_cases/`) and write `??` where an expression is missing.
   Hovering the `??` shows the hole's type and suggestions; completions are offered there too.

After changing server code, reload the host window (`Ctrl+R`) to pick up the rebuilt server.

## 1. Generate the tasks

```sh
cd dataset-generator/human-eval
python3 generate_rust2.py
cd ..
```

This reads `data2.jsonl` and writes `generated/` as a Cargo crate: `src/task_<N>.rs`
per task, a `src/main.rs` declaring them as modules, and a `Cargo.toml`. Tasks 11, 118
and 119 get a duplicated `fn` signature removed; task 38 is left out of `main.rs` because
it doesn't compile. The scraper needs the crate to resolve types.

## 2. Generate a dataset (punch holes)

From `dataset-generator/`:

```sh
cargo run --release -- human-eval/generated/src human-eval/generated/output
```

This writes `output/holes/task_<N>/hole<K>/task_<N>.{rs,json}`, raw candidates under
`output/candidates/`, and per-form counts in `output/results.txt`.
The output directory is wiped on every run.

## 3. Copy the holes into a dataset

Evaluators read datasets from `datasets/<name>/` (relative to the repo root):

```sh
cd ..   # repo root
mkdir -p datasets/my_dataset
cp -r dataset-generator/human-eval/generated/output/holes/* datasets/my_dataset/
```

## 4. Run the evaluations

Run from the repo root; all three take `--dataset=<name>` and write their results into
`datasets/<name>/`.

```sh
# Our tool -> eval_results.json, eval_table.{txt,md}
npm run evaluate -- --dataset=my_dataset

# rust-analyzer -> ra_eval_results.json, ra_eval_table.{txt,md}
npm run evaluateRa -- --dataset=my_dataset

# Side-by-side comparison (needs both results above) -> comparison_table.{txt,md}
npm run compareEval -- --dataset=my_dataset
```

Ownership flag:

```sh
npm run evaluate -- --no-ownership --dataset=my_dataset
```

`datasets/eval_dataset` contains a ready-made dataset with results, so step 4 can be run
directly with `--dataset=eval_dataset`.
