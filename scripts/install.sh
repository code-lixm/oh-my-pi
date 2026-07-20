#!/bin/sh
set -e
# ---------------------------------------------------------------------------
# Locale resolution — POSIX-only (`sh` doesn't support ${var,,} or arrays in
# every target), runs before any user-visible output. Precedence:
#   1. `OMP_LOCALE` / `PI_LOCALE` (explicit override)
#   2. `LC_ALL`
#   3. `LANG`
#   4. "en"
# Only the user chrome (status text, error messages) is translated; paths,
# URLs, package names, version numbers, and platform identifiers stay literal.
# ---------------------------------------------------------------------------
resolve_locale() {
    raw=""
    if [ -n "$OMP_LOCALE" ]; then
        raw="$OMP_LOCALE"
    elif [ -n "$PI_LOCALE" ]; then
        raw="$PI_LOCALE"
    elif [ -n "$LC_ALL" ]; then
        raw="$LC_ALL"
    elif [ -n "$LANG" ]; then
        raw="$LANG"
    fi
    if [ -z "$raw" ]; then
        echo "en"
        return
    fi
    # Lowercase + drop encoding suffix; only the first language tag matters
    # for our en/zh-CN gate. POSIX-portable: tr + cut.
    lower=$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')
    tag=$(printf '%s' "$lower" | cut -d. -f1 | cut -d_ -f1 | cut -d- -f1)
    case "$tag" in
        zh) echo "zh-CN" ;;
        en) echo "en" ;;
        *)  echo "en" ;;
    esac
}

LOCALE=$(resolve_locale)

# Translate a chrome key for the resolved locale. Falls back to the literal
# English text when a key has no translation under the active locale, so
# adding a new locale never breaks the installer.
#   $1 = key, $2.. = printf-style args substituted via sed-friendly placeholders
# We use a here-doc-like lookup table so the strings stay grep-friendly.
msg() {
    key="$1"; shift
    case "$LOCALE:$key" in
        # Generic chrome (labels used in multiple places)
        zh-CN:install.label.installing_bun) printf '正在安装 bun...';;
        zh-CN:install.label.installing_via_bun) printf '正在通过 bun 安装...';;
        zh-CN:install.label.installing_binary) printf '正在下载预编译二进制...';;
        zh-CN:install.label.fetching_release) printf '正在获取发布版本 %s...' "$1";;
        zh-CN:install.label.fetching_latest) printf '正在获取最新发布版本...';;
        zh-CN:install.label.downloading_binary) printf '正在下载 %s...' "$1";;
        zh-CN:install.label.using_version) printf '正在使用版本：%s' "$1";;
        zh-CN:install.installed_bun) printf '✓ 已通过 bun 安装 omp';;
        zh-CN:install.installed_binary) printf '✓ 已安装 omp 到 %s' "$1";;
        zh-CN:install.run_omp) printf '运行 omp 开始使用！';;
        zh-CN:install.add_to_path) printf '请将 %s 加入 PATH 后运行 omp' "$1";;
        # Argument errors
        zh-CN:install.err.missing_ref) printf '缺少 --ref 的取值';;
        zh-CN:install.err.missing_ref_short) printf '缺少 -r 的取值';;
        zh-CN:install.err.unknown_option) printf '未知选项：%s' "$1";;
        zh-CN:install.err.git_required_for_ref) printf '使用 --ref 从源码安装时需要 git';;
        zh-CN:install.err.bun_version_unreadable) printf '读取 bun 版本失败';;
        zh-CN:install.err.bun_version_old) printf '需要 Bun %s 或更高版本，当前版本：%s' "$1" "$2";;
        zh-CN:install.err.bun_upgrade_hint) printf '升级 Bun 请访问 https://bun.sh/docs/installation';;
        zh-CN:install.err.bash_missing) printf '未找到 bash；尝试使用 sh 安装...';;
        zh-CN:install.err.expected_package_missing) printf '未在 %s 找到预期的包' "$1";;
        zh-CN:install.err.install_source_failed) printf '从源码安装失败';;
        zh-CN:install.err.install_npm_failed) printf '安装 %s 失败' "$1";;
        zh-CN:install.err.unsupported_os) printf '不支持的操作系统：%s' "$1";;
        zh-CN:install.err.unsupported_arch) printf '不支持的架构：%s' "$1";;
        zh-CN:install.err.release_tag_missing) printf '未找到发布 tag：%s' "$1";;
        zh-CN:install.err.ref_needs_source_hint) printf '若要从分支/commit 安装，请结合 --source 使用 --ref。';;
        zh-CN:install.err.fetch_release_failed) printf '获取发布 tag 失败';;
        # English (default) — byte-identical to the original text so existing
        # snapshot tests / logs continue to match.
        en:*|*:install.*)
            case "$key" in
                install.label.installing_bun) printf 'Installing bun...';;
                install.label.installing_via_bun) printf 'Installing via bun...';;
                install.label.installing_binary) printf 'Downloading prebuilt binary...';;
                install.label.fetching_release) printf 'Fetching release %s...' "$1";;
                install.label.fetching_latest) printf 'Fetching latest release...';;
                install.label.downloading_binary) printf 'Downloading %s...' "$1";;
                install.label.using_version) printf 'Using version: %s' "$1";;
                install.installed_bun) printf '✓ Installed omp via bun';;
                install.installed_binary) printf '✓ Installed omp to %s' "$1";;
                install.run_omp) printf "Run 'omp' to get started!";;
                install.add_to_path) printf 'Add %s to your PATH, then run omp' "$1";;
                install.err.missing_ref) printf 'Missing value for --ref';;
                install.err.missing_ref_short) printf 'Missing value for -r';;
                install.err.unknown_option) printf 'Unknown option: %s' "$1";;
                install.err.git_required_for_ref) printf 'git is required for --ref when installing from source';;
                install.err.bun_version_unreadable) printf 'Failed to read bun version';;
                install.err.bun_version_old) printf 'Bun %s or newer is required. Current version: %s' "$1" "$2";;
                install.err.bun_upgrade_hint) printf 'Upgrade Bun at https://bun.sh/docs/installation';;
                install.err.bash_missing) printf 'bash not found; attempting install with sh...';;
                install.err.expected_package_missing) printf 'Expected package at %s' "$1";;
                install.err.install_source_failed) printf 'Failed to install from source';;
                install.err.install_npm_failed) printf 'Failed to install %s' "$1";;
                install.err.unsupported_os) printf 'Unsupported OS: %s' "$1";;
                install.err.unsupported_arch) printf 'Unsupported architecture: %s' "$1";;
                install.err.release_tag_missing) printf 'Release tag not found: %s' "$1";;
                install.err.ref_needs_source_hint) printf 'For branch/commit installs, use --source with --ref.';;
                install.err.fetch_release_failed) printf 'Failed to fetch release tag';;
                *) printf '%s' "$key";;
            esac
            ;;
    esac
}

# Print a localized label (no trailing newline). Shifts the key out of `$@`
# so positional placeholders match the message table without re-quoting the key.
label() { key="$1"; shift; msg "install.label.$key" "$@"; }

# Print a localized error line to stderr.
err() { key="$1"; shift; msg "install.err.$key" "$@" >&2; }
# OMP Coding Agent Installer
#
# Options:
#   --source       Install via bun (installs bun if needed)
#   --binary       Always install prebuilt binary
#   --ref <ref>    Install specific tag/commit/branch
#   -r <ref>       Shorthand for --ref

REPO="can1357/oh-my-pi"
PACKAGE="@oh-my-pi/pi-coding-agent"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
MIN_BUN_VERSION="1.3.14"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                err missing_ref
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                err missing_ref
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                err missing_ref_short
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            err unknown_option "$1"
            exit 1
            ;;
    esac
done

# If a ref is provided, default to source install
if [ -n "$REF" ] && [ -z "$MODE" ]; then
    MODE="source"
fi

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        err bun_version_unreadable
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        err bun_version_old "$MIN_BUN_VERSION" "$version_clean"
        err bun_upgrade_hint
        exit 1
    fi
}
# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

install_bun() {
    label installing_bun; echo
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        err bash_missing
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

install_via_bun() {
    label installing_via_bun; echo
    if [ -n "$REF" ]; then
        if ! has_git; then
            err git_required_for_ref
            exit 1
        fi

        TMP_DIR="$(mktemp -d)"
        trap 'rm -rf "$TMP_DIR"' EXIT

        if git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$TMP_DIR" >/dev/null 2>&1; then
            :
        else
            git clone "https://github.com/${REPO}.git" "$TMP_DIR"
            (cd "$TMP_DIR" && git checkout "$REF")
        fi

        # Pull LFS files
        if has_git_lfs; then
            (cd "$TMP_DIR" && git lfs pull)
        fi

        if [ ! -d "$TMP_DIR/packages/coding-agent" ]; then
            err expected_package_missing "${TMP_DIR}/packages/coding-agent"
            exit 1
        fi

        bun install -g "$TMP_DIR/packages/coding-agent" || {
            err install_source_failed
            exit 1
        }
    else
        bun install -g "$PACKAGE" || {
            err install_npm_failed "$PACKAGE"
            exit 1
        }
    fi
    echo ""
    msg install.installed_bun; echo
    msg install.run_omp; echo
}

install_binary() {
    # Detect platform
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      err unsupported_os "$OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *)             err unsupported_arch "$ARCH"; exit 1 ;;
    esac

    BINARY="omp-${PLATFORM}-${ARCH}"
    # Get release tag
    if [ -n "$REF" ]; then
        label fetching_release "$REF"; echo
        if RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/tags/${REF}"); then
            LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
        else
            err release_tag_missing "$REF"
            err ref_needs_source_hint
            exit 1
        fi
    else
        label fetching_latest; echo
        RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/latest")
        LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    fi

    if [ -z "$LATEST" ]; then
        err fetch_release_failed
        exit 1
    fi
    label using_version "$LATEST"; echo

    mkdir -p "$INSTALL_DIR"
    # Download binary
    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    label downloading_binary "$BINARY"; echo
    curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$BINARY_URL" -o "${INSTALL_DIR}/omp"
    chmod +x "${INSTALL_DIR}/omp"
    echo ""
    msg install.installed_binary "${INSTALL_DIR}/omp"; echo

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:") msg install.run_omp; echo ;;
        *) msg install.add_to_path "$INSTALL_DIR"; echo ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        install_via_bun
        ;;
    binary)
        install_binary
        ;;
    *)
        # Default: use bun if available, otherwise binary
        if has_bun; then
            require_bun_version
            install_via_bun
        else
            install_binary
        fi
        ;;
esac
