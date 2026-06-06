export function parseArgs(argv) {
  const args = { _: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }

    const eq = value.indexOf("=");
    if (eq !== -1) {
      args[value.slice(2, eq)] = value.slice(eq + 1);
      continue;
    }

    const key = value.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

export function requireArg(args, key) {
  const value = args[key];
  if (value === undefined || value === true || value === "") {
    throw new Error(`Missing required --${key}`);
  }
  return value;
}

export function validateValueOptions(args, keys) {
  for (const key of keys) {
    if (args[key] === true || args[key] === "") {
      throw new Error(`--${key} requires a value`);
    }
  }
}

export function numberArg(args, key, fallback) {
  if (args[key] === undefined || args[key] === true) {
    return fallback;
  }
  const parsed = Number(args[key]);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${key} must be a number`);
  }
  return parsed;
}
