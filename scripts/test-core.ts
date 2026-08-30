import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const testsDir = resolve(root, "tests");
const requestedBatchSize = Number.parseInt(process.env.ASTERBRIDGE_TEST_BATCH_SIZE ?? "1", 10);
const runtimeCrashRetries = Number.parseInt(process.env.ASTERBRIDGE_BUN_CRASH_RETRIES ?? "2", 10);
if (!Number.isInteger(requestedBatchSize) || requestedBatchSize < 1 || requestedBatchSize > 20) {
  throw new Error("ASTERBRIDGE_TEST_BATCH_SIZE must be an integer between 1 and 20");
}
if (!Number.isInteger(runtimeCrashRetries) || runtimeCrashRetries < 0 || runtimeCrashRetries > 5) {
  throw new Error("ASTERBRIDGE_BUN_CRASH_RETRIES must be an integer between 0 and 5");
}

const retryableRuntimeExitCodes = new Set([3, 134, 139, 3221225477]);

const testFiles = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `tests/${name}`);
if (testFiles.length === 0) throw new Error("No core test files found");

const batchCount = Math.ceil(testFiles.length / requestedBatchSize);
for (let offset = 0; offset < testFiles.length; offset += requestedBatchSize) {
  const batch = testFiles.slice(offset, offset + requestedBatchSize);
  const batchNumber = Math.floor(offset / requestedBatchSize) + 1;
  process.stdout.write(`[core-test] batch ${batchNumber}/${batchCount}: ${batch.join(", ")}\n`);
  let passed = false;
  for (let attempt = 0; attempt <= runtimeCrashRetries; attempt += 1) {
    const child = Bun.spawn([process.execPath, "test", ...batch], {
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode === 0) {
      passed = true;
      break;
    }
    const retryableRuntimeCrash = retryableRuntimeExitCodes.has(exitCode);
    if (!retryableRuntimeCrash || attempt === runtimeCrashRetries) {
      throw new Error(`Core test batch ${batchNumber}/${batchCount} failed with exit code ${exitCode}`);
    }
    process.stderr.write(
      `[core-test] Bun runtime crash (exit ${exitCode}) in batch ${batchNumber}/${batchCount}; retry ${attempt + 1}/${runtimeCrashRetries}\n`,
    );
  }
  if (!passed) throw new Error(`Core test batch ${batchNumber}/${batchCount} did not complete`);
}

process.stdout.write(`[core-test] PASS ${testFiles.length} files in ${batchCount} deterministic batches\n`);
