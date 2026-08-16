import { runLoop, type RunLoopLifecycleFaultPoint } from "../../src/loop.js";

const point = String(process.env.RUNTIME_LOOP_FAULT || "") as RunLoopLifecycleFaultPoint;
try {
  await runLoop({ once: true, lifecycleFaultAt: point });
  process.exitCode = 0;
} catch (error: any) {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exitCode = 2;
}
