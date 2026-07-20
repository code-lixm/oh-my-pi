#!/bin/sh
# Install the locally built `omp` binary into Bun's global bin directory.
#
# `bun --cwd=packages/coding-agent link` points at `src/cli.ts`, so every source
# edit immediately changes the globally linked command. The setup flow builds a
# stable snapshot at `packages/coding-agent/dist/omp`; this script links a small
# launcher that executes that snapshot with its package assets available.
#
# We resolve Bun's global bin path defensively because `bun pm -g bin` aborts
# (`No package.json was found for directory "$HOME/.bun/install/global"`) on
# fresh hosts where the global install has not been initialized. Falling
# through that error would expand `$(bun pm -g bin)/omp` to `/omp` and try to
# write under `/` — see https://github.com/can1357/oh-my-pi/issues/3701.
#
# Minimal in-script i18n for the user-facing messages. Locale resolution:
# explicit OMP_LOCALE / PI_LOCALE > LC_ALL > LANG; anything starting with "zh"
# maps to zh-CN, otherwise English. Machine data (paths, error text from bun)
# is left untouched.
set -e

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
target=$repo_root/packages/coding-agent/dist/omp
launcher=$repo_root/scripts/omp-launcher.sh

# Resolve locale without eval. Empty overrides fall back to the next source.
locale=$(printf '%s' "${OMP_LOCALE:-${PI_LOCALE:-${LC_ALL:-${LANG:-}}}}" | tr -d '[:space:]')
case $locale in
	zh*) locale=zh-CN ;;
	*)   locale=en ;;
esac

if [ "$locale" = "zh-CN" ]; then
	msg_target_missing="link-omp: 构建产物未找到或不可执行：$target；请先运行 bun --cwd=packages/coding-agent run build"

else
	msg_target_missing="link-omp: build artifact not found or not executable: $target; run bun --cwd=packages/coding-agent run build first"

fi

if [ ! -x "$target" ]; then
	echo "$msg_target_missing" >&2
	exit 1
fi

global_bin=$(bun pm -g bin 2>/dev/null || true)
if [ -z "$global_bin" ]; then
	global_bin=${BUN_INSTALL:-$HOME/.bun}/bin
fi

mkdir -p "$global_bin"
ln -sfn "$launcher" "$global_bin/omp"

if [ "$locale" = "zh-CN" ]; then
	echo "link-omp: 已安装 $global_bin/omp -> $launcher（执行 $target）"
else
	echo "link-omp: installed $global_bin/omp -> $launcher (executes $target)"
fi