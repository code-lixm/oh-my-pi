#!/bin/sh
# Run the locally built omp snapshot with package assets available.
set -e

launcher_path=$(readlink "$0" 2>/dev/null || printf '%s\n' "$0")
repo_root=$(CDPATH= cd -- "$(dirname -- "$launcher_path")/.." && pwd -P)
package_dir=$repo_root/packages/coding-agent
target=$package_dir/dist/omp

PI_PACKAGE_DIR="$package_dir" exec "$target" "$@"
