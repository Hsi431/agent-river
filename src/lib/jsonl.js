import fs from "node:fs";
import path from "node:path";

export function readJsonlWithPositions(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\n/);
  const rows = [];
  let offset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 1;
    if (raw.trim() !== "") {
      try {
        rows.push({
          value: JSON.parse(raw),
          raw,
          line,
          offset,
        });
      } catch (error) {
        rows.push({
          error: error.message,
          raw,
          line,
          offset,
        });
      }
    }
    offset += Buffer.byteLength(raw, "utf8") + 1;
  }

  return rows;
}

export function readJsonl(filePath) {
  return readJsonlWithPositions(filePath)
    .filter((row) => row.value)
    .map((row) => row.value);
}

export function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

export function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = values.map((value) => JSON.stringify(value)).join("\n");
  fs.writeFileSync(filePath, body ? `${body}\n` : "");
}
