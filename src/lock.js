import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./util/paths.js";

const directory = join(dataDir, "locks");
export function acquireLock(name, root = directory) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid lock name");
  const path = join(root, `${name}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  let fd;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner;
    try { owner = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error(`The ${name} lock is malformed; inspect it manually.`); }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error(`The ${name} lock is malformed; inspect it manually.`);
    try { process.kill(owner.pid, 0); }
    catch (probeError) {
      if (probeError.code !== "ESRCH") throw probeError;
      // SIGKILL cannot run finally handlers. Reclaim only a lock whose recorded
      // owner is definitely gone, then retry the exclusive create once.
      unlinkSync(path);
      fd = openSync(path, "wx", 0o600);
    }
    if (fd === undefined) throw new Error(`Another process holds the ${name} lock.`);
  }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })); }
  finally { closeSync(fd); }
  return () => {
    if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path);
  };
}

export function unlockStoppedProcess(name, root = directory) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid lock name");
  const path = join(root, `${name}.json`);
  const owner = JSON.parse(readFileSync(path, "utf8"));
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("Malformed lock; inspect it manually.");
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if (error.code !== "ESRCH") throw error;
    unlinkSync(path);
    return;
  }
  throw new Error(`Process ${owner.pid} is still running. Refusing to remove its lock.`);
}
