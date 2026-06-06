import { createHash } from "node:crypto";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function shortHash(value) {
  return sha256(value).slice(0, 16);
}
