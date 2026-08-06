#!/usr/bin/env bash
# Installs the compiler toolchain and system libraries for an R package build.
# Inputs via env: TOOLCHAIN (auto|none), SYSDEPS (auto|none|space-separated
# distro package names), SYSDEPS_IGNORE and SYSDEPS_EXTRA (space-separated,
# auto mode only), PLATFORM (optional resolved platform as <id><major>, e.g.
# almalinux8; empty detects from /etc/os-release). Runs as-is in containers
# (root) and on bare-metal runners (non-root with passwordless sudo).
set -euo pipefail

TOOLCHAIN="${TOOLCHAIN:-auto}"
SYSDEPS="${SYSDEPS:-auto}"
SYSDEPS_IGNORE="${SYSDEPS_IGNORE:-}"
SYSDEPS_EXTRA="${SYSDEPS_EXTRA:-}"
PLATFORM="${PLATFORM:-}"
OS_RELEASE="${OS_RELEASE:-/etc/os-release}"

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

as_root() {
    ${SUDO:+"$SUDO"} "$@"
}

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

# One splitting idiom for every list input: read -a never globs, -d '' makes
# the whole here-string one record so newlines split like spaces, and || true
# absorbs read's guaranteed non-zero EOF status under set -e.
SPLIT_WS=()
split_ws() {
    SPLIT_WS=()
    read -r -d '' -a SPLIT_WS <<< "$1" || true
}

DISTRO_ID="unknown"
DISTRO_MAJOR="0"
detect_platform() {
    if [ -n "$PLATFORM" ]; then
        if [[ ! "$PLATFORM" =~ ^([a-z]+)([0-9]+)$ ]]; then
            echo "::error::setup-build-env: malformed platform \"$PLATFORM\" (expected <id><major>, e.g. almalinux8)"
            exit 1
        fi
        DISTRO_ID="${BASH_REMATCH[1]}"
        DISTRO_MAJOR="${BASH_REMATCH[2]}"
        return 0
    fi
    local fields
    # shellcheck disable=SC1090
    fields=$(. "$OS_RELEASE" 2>/dev/null && echo "${ID:-unknown} ${VERSION_ID:-0}") || fields="unknown 0"
    read -r DISTRO_ID DISTRO_MAJOR <<< "$fields"
    DISTRO_MAJOR="${DISTRO_MAJOR%%.*}"
}
detect_platform

APT_UPDATED=false
RPM_REPO_FLAGS=()
install_pkgs() {
    if [ "$#" -eq 0 ]; then
        return 0
    fi
    echo "setup-build-env: installing with $PM: $*"
    case "$PM" in
        apt-get)
            if [ "$APT_UPDATED" = false ]; then
                as_root apt-get update -qq
                APT_UPDATED=true
            fi
            as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
            ;;
        zypper)
            as_root zypper --non-interactive install "$@"
            ;;
        *)
            as_root "$PM" install -y ${RPM_REPO_FLAGS[@]+"${RPM_REPO_FLAGS[@]}"} "$@"
            ;;
    esac
}

# Most -devel packages on EL distros live outside the base repos: EPEL plus
# the builder repo, named PowerTools on EL8 and CRB from EL9 on. The builder
# repo is enabled per-install through --enablerepo, which dnf, microdnf, and
# yum all accept — unlike dnf config-manager, which the others lack and dnf5
# renamed. Distro IDs correspond to shared/platforms.json's linux_id_map.
ensure_rpm_repos() {
    case "$PM" in
        dnf|microdnf|yum) ;;
        *) return 0 ;;
    esac
    case "$DISTRO_ID" in
        almalinux|alma|rocky|centos)
            local repo
            case "$DISTRO_MAJOR" in
                8) repo="powertools" ;;
                9|10) repo="crb" ;;
                *)
                    echo "::notice::setup-build-env: no repo recipe for ${DISTRO_ID}${DISTRO_MAJOR}; installing from configured repos only"
                    return 0
                    ;;
            esac
            echo "setup-build-env: enabling EPEL and ${repo} on ${DISTRO_ID}${DISTRO_MAJOR}"
            install_pkgs epel-release
            RPM_REPO_FLAGS+=("--enablerepo=${repo}")
            ;;
        rhel)
            # Best-effort: RHEL/UBI has no epel-release package, and unentitled
            # UBI images may lack CRB entirely, so failures warn and continue.
            local epel_url="https://dl.fedoraproject.org/pub/epel/epel-release-latest-${DISTRO_MAJOR}.noarch.rpm"
            echo "setup-build-env: enabling EPEL and CRB (best effort) on rhel${DISTRO_MAJOR}"
            # rpm -ivh fallback because microdnf cannot install from a URL.
            if ! install_pkgs "$epel_url" && ! as_root rpm -ivh "$epel_url"; then
                echo "::warning::setup-build-env: could not install EPEL on rhel${DISTRO_MAJOR}; continuing without it"
            fi
            local crb_repo repolist
            crb_repo="codeready-builder-for-rhel-${DISTRO_MAJOR}-$(uname -m)-rpms"
            # --enablerepo for an undefined repo hard-fails, so probe first.
            repolist=$(as_root "$PM" repolist --all 2>/dev/null) || repolist=""
            if [[ "$repolist" == *"$crb_repo"* ]]; then
                RPM_REPO_FLAGS+=("--enablerepo=${crb_repo}")
            else
                echo "::notice::setup-build-env: ${crb_repo} not available on this system; installing without it"
            fi
            ;;
        fedora)
            # Everything needed is in the main repos.
            ;;
        *)
            echo "::notice::setup-build-env: repo enablement not implemented for ${DISTRO_ID}; installing from configured repos only"
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
            split_ws "$SYSDEPS_IGNORE"
            ignore_flags=()
            for dep in ${SPLIT_WS[@]+"${SPLIT_WS[@]}"}; do
                ignore_flags+=(--ignore "$dep")
            done
            # Assignments first so a failing rv or jq exits the script instead
            # of silently producing an empty list.
            sysdeps_json=$(rv sysdeps --json --only-absent ${ignore_flags[@]+"${ignore_flags[@]}"})
            pkg_lines=$(jq -r '.[]' <<< "$sysdeps_json")
            split_ws "$pkg_lines"
            pkgs=(${SPLIT_WS[@]+"${SPLIT_WS[@]}"})
            # The notice is about what rv resolved, so it precedes the extras.
            if [ "${#pkgs[@]}" -eq 0 ]; then
                echo "::notice::setup-build-env: no system dependencies resolved — either none are required, or this platform is not supported by rv sysdeps"
            fi
            split_ws "$SYSDEPS_EXTRA"
            pkgs+=(${SPLIT_WS[@]+"${SPLIT_WS[@]}"})
            if [ "${#pkgs[@]}" -gt 0 ]; then
                ensure_rpm_repos
                install_pkgs "${pkgs[@]}"
            fi
        fi
        ;;
    *)
        split_ws "$SYSDEPS"
        pkgs=(${SPLIT_WS[@]+"${SPLIT_WS[@]}"})
        if [ "${#pkgs[@]}" -gt 0 ]; then
            ensure_rpm_repos
            install_pkgs "${pkgs[@]}"
        fi
        ;;
esac
