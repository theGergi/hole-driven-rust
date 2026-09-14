import json
import os

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "generated")
SRC_DIR = os.path.join(OUTPUT_DIR, "src")

# Tasks left out of main.rs. task_38's declaration is followed by task_37's
# body and then its real solution, so it doesn't compile.
EXCLUDED_TASKS = {"38"}

# Tasks whose declaration repeats the solution's `fn` signature, leaving the
# first copy unclosed.
DUPLICATE_FN_TASKS = {"11", "118", "119"}

CARGO_TOML = """[package]
name = "human-eval-generated"
version = "0.1.0"
edition = "2021"

[dependencies]
rand = "0.8"
regex = "1"
md5 = "0.7"
"""

MAIN_HEADER = "#![allow(dead_code, unused_imports, unused_variables, unused_mut)]\n\n"

def remove_duplicate_fn(content):
    """Drop a `fn` line (and the blank lines after it) when the next non-blank
    line is the same signature."""
    lines = content.split("\n")
    out = []
    i = 0
    while i < len(lines):
        if lines[i].startswith("fn "):
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines) and lines[j] == lines[i]:
                i = j
                continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


# data2.jsonl holds concatenated pretty-printed JSON objects, so decode
# them one after another instead of line by line.
with open(os.path.join(os.path.dirname(__file__), "data2.jsonl")) as f:
    text = f.read()

decoder = json.JSONDecoder()
rows = []
pos = 0
while pos < len(text):
    while pos < len(text) and text[pos].isspace():
        pos += 1
    if pos >= len(text):
        break
    row, pos = decoder.raw_decode(text, pos)
    rows.append(row)

os.makedirs(SRC_DIR, exist_ok=True)

modules = []
for row in rows:
    task_id = row["task_id"]          # e.g. "Rust/0"
    idx = task_id.split("/")[-1]      # "0"

    content = row["declaration"] + row["cannonical_solution"]
    if idx in DUPLICATE_FN_TASKS:
        content = remove_duplicate_fn(content)

    out_path = os.path.join(SRC_DIR, f"task_{idx}.rs")
    with open(out_path, "w") as f:
        f.write(content)

    if idx not in EXCLUDED_TASKS:
        modules.append(f"#[path = \"task_{idx}.rs\"]\nmod task_{idx};\n")

with open(os.path.join(SRC_DIR, "main.rs"), "w") as f:
    f.write(MAIN_HEADER + "\n".join(modules) + "\nfn main() {\n}\n")

with open(os.path.join(OUTPUT_DIR, "Cargo.toml"), "w") as f:
    f.write(CARGO_TOML)

print(f"Generated {len(rows)} files and main.rs ({len(modules)} modules) in {SRC_DIR}/")
