#!/usr/bin/env bash
# Installs the compiler toolchain and system libraries for an R package build.
# Inputs via env: TOOLCHAIN (auto|none), SYSDEPS (auto|none|space-separated
# distro package names), SYSDEPS_IGNORE and SYSDEPS_EXTRA (space-separated,
# auto mode only). Runs as-is in containers (root) and on bare-metal runners
# (non-root with passwordless sudo).
set -euo pipefail

TOOLCHAIN="${TOOLCHAIN:-auto}"
SYSDEPS="${SYSDEPS:-auto}"
SYSDEPS_IGNORE="${SYSDEPS_IGNORE:-}"
SYSDEPS_EXTRA="${SYSDEPS_EXTRA:-}"

if [ "$(uname -s)" != "Linux" ]; then
    echo "::notice::setup-build-env: toolchain/sysdeps management only applies to linux; nothing to do on $(uname -s)"
    exit 0
fi

SUDO=""
if [ "$(id -u)" != "0" ]; then
    if command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
    else
        echo "::error::setup-build-env: not running as root and sudo is unavailable"
        exit 1
    fi
fi

PM=""
for candidate in dnf microdnf yum apt-get zypper; do
    if command -v "$candidate" >/dev/null 2>&1; then
        PM="$candidate"
        break
    fi
done
if [ -z "$PM" ]; then
    echo "::error::setup-build-env: no supported package manager found (dnf/microdnf/yum/apt-get/zypper)"
    exit 1
fi

APT_UPDATED=false
install_pkgs() {
    if [ "$#" -eq 0 ]; then
        return 0
    fi
    echo "setup-build-env: installing with $PM: $*"
    case "$PM" in
        apt-get)
            if [ "$APT_UPDATED" = false ]; then
                $SUDO apt-get update -qq
                APT_UPDATED=true
            fi
            $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
            ;;
        zypper)
            $SUDO zypper --non-interactive install "$@"
            ;;
        *)
            $SUDO "$PM" install -y "$@"
            ;;
    esac
}

# Most -devel packages on EL distros live outside the base repos: EPEL plus
# the builder repo, named PowerTools on EL8 and CRB from EL9 on. Enabling them
# needs dnf's config-manager plugin, so other package managers are left alone.
enable_rpm_repos() {
    if [ "$PM" != "dnf" ]; then
        return 0
    fi
    local id major repo
    id=$(. /etc/os-release 2>/dev/null && echo "${ID:-}" || true)
    major=$(. /etc/os-release 2>/dev/null && echo "${VERSION_ID:-0}" | cut -d. -f1 || true)
    case "$id" in
        almalinux|rocky|centos) ;;
        *) return 0 ;;
    esac
    case "$major" in
        8) repo="powertools" ;;
        9|10) repo="crb" ;;
        *) return 0 ;;
    esac
    echo "setup-build-env: enabling EPEL and ${repo} on ${id}${major}"
    $SUDO dnf install -y epel-release dnf-plugins-core
    $SUDO dnf config-manager --set-enabled "$repo"
}

case "$TOOLCHAIN" in
    none)
        echo "setup-build-env: toolchain=none, skipping toolchain install"
        ;;
    auto)
        case "$PM" in
            apt-get) install_pkgs build-essential gfortran ;;
            zypper)  install_pkgs gcc gcc-c++ gcc-fortran make ;;
            *)       install_pkgs gcc gcc-c++ gcc-gfortran make ;;
        esac
        ;;
    *)
        echo "::error::setup-build-env: unknown toolchain value \"$TOOLCHAIN\" (expected auto or none)"
        exit 1
        ;;
esac

if [ "$SYSDEPS" != "auto" ] && { [ -n "$SYSDEPS_IGNORE" ] || [ -n "$SYSDEPS_EXTRA" ]; }; then
    echo "::warning::setup-build-env: sysdeps_ignore/sysdeps_extra only apply with sysdeps=auto — ignoring them"
fi

case "$SYSDEPS" in
    none)
        echo "setup-build-env: sysdeps=none, skipping system dependencies"
        ;;
    auto)
        if ! command -v rv >/dev/null 2>&1; then
            echo "::warning::setup-build-env: sysdeps=auto requires rv on PATH — skipping system dependency resolution"
        else
            if ! command -v jq >/dev/null 2>&1; then
                install_pkgs jq
            fi
            ignore_flags=()
            for dep in $SYSDEPS_IGNORE; do
                ignore_flags+=(--ignore "$dep")
            done
            # Assignment first so a failing rv exits the script instead of
            # silently producing an empty list through process substitution.
            sysdeps_json=$(rv sysdeps --json --only-absent ${ignore_flags[@]+"${ignore_flags[@]}"})
            mapfile -t pkgs < <(jq -r '.[]' <<< "$sysdeps_json")
            read -r -a extra <<< "$SYSDEPS_EXTRA"
            pkgs+=(${extra[@]+"${extra[@]}"})
            if [ "${#pkgs[@]}" -eq 0 ]; then
                echo "::notice::setup-build-env: no system dependencies resolved — either none are required, or this platform is not supported by rv sysdeps"
            else
                enable_rpm_repos
                install_pkgs "${pkgs[@]}"
            fi
        fi
        ;;
    *)
        read -r -a pkgs <<< "$SYSDEPS"
        if [ "${#pkgs[@]}" -gt 0 ]; then
            enable_rpm_repos
            install_pkgs "${pkgs[@]}"
        fi
        ;;
esac
