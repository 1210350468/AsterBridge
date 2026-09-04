import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

const attempts = boundedInteger("ASTERBRIDGE_AUDIT_ATTEMPTS", 2, 1, 5);
const timeoutMs = boundedInteger("ASTERBRIDGE_AUDIT_TIMEOUT_MS", 60_000, 10_000, 300_000);
const retryDelayMs = boundedInteger("ASTERBRIDGE_AUDIT_RETRY_DELAY_MS", 3_000, 0, 30_000);

interface AuditTarget {
  label: string;
  cwd: string;
}

const targets: AuditTarget[] = [
  { label: "root", cwd: root },
  { label: "launcher", cwd: resolve(root, "launcher") },
];

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream ? new Response(stream).text() : Promise.resolve("");
}

async function auditTarget(target: AuditTarget): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    process.stdout.write(`[audit] ${target.label} attempt ${attempt}/${attempts}\n`);
    const child = Bun.spawn([process.execPath, "audit"], {
      cwd: target.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = readStream(child.stdout);
    const stderrPromise = readStream(child.stderr);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already exited */ }
    }, timeoutMs);
    const exitCode = await child.exited;
    clearTimeout(timeout);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (!timedOut && exitCode === 0) {
      process.stdout.write(`[audit] ${target.label} PASS\n`);
      return;
    }
    const reason = timedOut
      ? `timed out after ${timeoutMs} ms`
      : `exited with code ${exitCode}`;
    if (attempt === attempts) {
      throw new Error(`Dependency audit for ${target.label} ${reason}`);
    }
    process.stderr.write(`[audit] ${target.label} ${reason}; retrying\n`);
    if (retryDelayMs > 0) await Bun.sleep(retryDelayMs);
  }
}

for (const target of targets) await auditTarget(target);
process.stdout.write("DEPENDENCY_AUDIT_OK root+launcher\n");
