#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo 'Node 22+ is required. Install Node before running this installer.' >&2; exit 1; }
task_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$task_dir/install.mjs" "$@"
