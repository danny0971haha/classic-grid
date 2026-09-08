#!/usr/bin/env python3
"""Record a bootstrap/regression command, including failure, into a fresh directory."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--out', type=Path, required=True)
p.add_argument('command', nargs=argparse.REMAINDER)
a = p.parse_args()
a.out.mkdir(parents=True, exist_ok=False)
command = a.command[1:] if a.command[:1] == ['--'] else a.command
record = {'command': command, 'cwd': os.getcwd(), 'started_at_utc': datetime.now(timezone.utc).isoformat()}
with (a.out / 'stdout').open('wb') as out, (a.out / 'stderr').open('wb') as err:
    try:
        with subprocess.Popen(command, stdout=out, stderr=err, start_new_session=True) as child:
            try:
                code = child.wait(timeout=600)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                code = 124
    except OSError as error:
        err.write((str(error)+'\n').encode())
        code = 127
record.update(exitCode=code, ended_at_utc=datetime.now(timezone.utc).isoformat())
(a.out / 'command.json').write_text(json.dumps(record, indent=2)+'\n')
print(json.dumps(record))
sys.exit(code)
