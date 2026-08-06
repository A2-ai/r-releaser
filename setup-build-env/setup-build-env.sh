#!/usr/bin/env bash
# Installs the compiler toolchain and system libraries for an R package build.
# Inputs via env: TOOLCHAIN (auto|none), SYSDEPS (auto|none|space-separated
# distro package names). Runs as-is in containers (root) and on bare-metal
# runners (non-root with passwordless sudo).
set -euo pipefail

TOOLCHAIN="${TOOLCHAIN:-auto}"
SYSDEPS="${SYSDEPS:-auto}"

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

case "$SYSDEPS" in
    none)
        echo "setup-build-env: sysdeps=none, skipping system dependencies"
        ;;
    auto)
        if ! command -v rv >/dev/null 2>&1; then
            echo "::warning::setup-build-env: sysdeps=auto requires rv on PATH — skipping system dependency resolution"
        elif [ "$PM" != "apt-get" ]; then
            echo "::notice::setup-build-env: rv sysdeps only supports Ubuntu/Debian — skipping sysdeps=auto on this distro. Set an explicit sysdeps map in prism.yml if the build needs system libraries."
        else
            if ! command -v jq >/dev/null 2>&1; then
                install_pkgs jq
            fi
            mapfile -t pkgs < <(rv sysdeps --json --only-absent | jq -r '.[]')
            if [ "${#pkgs[@]}" -eq 0 ]; then
                echo "setup-build-env: rv sysdeps reports nothing missing"
            else
                install_pkgs "${pkgs[@]}"
            fi
        fi
        ;;
    *)
        read -r -a pkgs <<< "$SYSDEPS"
        install_pkgs "${pkgs[@]}"
        ;;
esac
