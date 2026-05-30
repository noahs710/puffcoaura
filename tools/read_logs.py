import json
import os

transcript_path = r"C:\Users\Gabrielle Monlea\.gemini\antigravity\brain\c4d9dd97-a0a2-456a-b526-6e3cb2c73feb\.system_generated\logs\transcript.jsonl"
output_path = r"C:\PuffcoBLE\test_soc_search.txt"

if not os.path.exists(transcript_path):
    print("Transcript not found at", transcript_path)
    exit(1)

found = []
with open(transcript_path, "r", encoding="utf-8") as f:
    for line_idx, line in enumerate(f):
        try:
            data = json.loads(line)
            content = data.get("content", "")
            if "test_soc" in content or "test_soc.py" in content or "soc:" in content.lower():
                found.append((line_idx, data.get("type"), data.get("source"), content[:2000]))
        except Exception as e:
            pass

print(f"Found {len(found)} matches for test_soc.")
with open(output_path, "w", encoding="utf-8") as out:
    for idx, (l_idx, step_type, source, content) in enumerate(found):
        out.write(f"=== Match {idx} (Line {l_idx}, Type: {step_type}, Source: {source}) ===\n")
        out.write(content)
        out.write("\n\n")
