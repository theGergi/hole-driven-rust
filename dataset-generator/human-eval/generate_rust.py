import json
import os

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "generated")

with open(os.path.join(os.path.dirname(__file__), "data.json")) as f:
    data = json.load(f)

os.makedirs(OUTPUT_DIR, exist_ok=True)

for entry in data["rows"]:
    row = entry["row"]
    task_id = row["task_id"]          # e.g. "Rust/0"
    idx = task_id.split("/")[-1]      # "0"

    content = row["declaration"] + row["cannonical_solution"]

    out_path = os.path.join(OUTPUT_DIR, f"task_{idx}.rs")
    with open(out_path, "w") as f:
        f.write(content)

print(f"Generated {len(data['rows'])} files in {OUTPUT_DIR}/")
