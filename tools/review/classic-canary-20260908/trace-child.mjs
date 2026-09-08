// Preserve raw nested pack/install/audit/probe subprocess results without changing their exits.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const original = childProcess.spawnSync;
let sequence = 0;
childProcess.spawnSync = function(command, args, options) {
  const started = new Date().toISOString();
  const result = original.call(this, command, args, options);
  const dir = process.env.CANARY_TRACE_DIR;
  if (!dir) throw new Error('CANARY_TRACE_DIR_REQUIRED');
  fs.mkdirSync(dir, { recursive: true });
  const stem = `${process.pid}-${String(++sequence).padStart(3, '0')}`;
  fs.writeFileSync(path.join(dir, `${stem}.stdout`), result.stdout ?? '');
  fs.writeFileSync(path.join(dir, `${stem}.stderr`), result.stderr ?? '');
  fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify({
    command: [command, ...(args ?? [])], cwd: options?.cwd ?? process.cwd(),
    started_at_utc: started, ended_at_utc: new Date().toISOString(),
    exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
    stdout: `${stem}.stdout`, stderr: `${stem}.stderr`,
  }, null, 2) + '\n');
  return result;
};
syncBuiltinESMExports();
