import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import platforms from '../shared/platforms.json';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup-build-env.sh');

// Resolve the bash the shebang's `env` would find; skip the suite without one.
const bashPath = (() => {
    try {
        return execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
})();

// Real utilities the script itself needs (fixture inspection, stub
// materialization); symlinked into the stub dir so they resolve without
// opening PATH to the whole system. Their calls are not logged.
const realTools = Object.fromEntries(['find', 'grep', 'chmod'].map((name) => {
    try {
        return [name, execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim()];
    } catch {
        return [name, null];
    }
}));

// Every stub logs "<name> <args>" to $CALL_LOG, then runs its body. Canned
// behavior is driven by env vars so each test declares its world up front.
const stubBodies = {
    uname: `case "\${1:-}" in
    -m) echo x86_64 ;;
    *) echo "\${UNAME_S:-Linux}" ;;
esac`,
    id: 'echo "${ID_U:-0}"',
    sudo: 'exec "$@"',
    env: `while [ "$#" -gt 0 ]; do
    case "$1" in *=*) shift ;; *) break ;; esac
done
exec "$@"`,
    rpm: 'exit "${RPM_EXIT:-0}"',
    rv: `if [ "\${RV_EXIT:-0}" != 0 ]; then exit "\${RV_EXIT}"; fi
printf '%s\\n' "\${RV_JSON:-[]}"`,
    jq: `cat > /dev/null
if [ "\${JQ_EXIT:-0}" != 0 ]; then exit "\${JQ_EXIT}"; fi
if [ -n "\${JQ_OUTPUT:-}" ]; then printf '%s\\n' "\${JQ_OUTPUT}"; fi`,
    curl: 'exit 0',
    sh: 'exit 0',
};

// PROVIDES materializes a log-only stub for the named tool on install, so a
// test can assert the script installs a missing tool before invoking it. The
// stub's shebang comes from $BASH — env can't find bash on the stub-only PATH.
const pmBody = `if [ "\${1:-}" = "repolist" ]; then
    printf '%s\\n' "\${REPOLIST_OUTPUT:-}"
    exit 0
fi
if [ -n "\${FAIL_ON:-}" ]; then
    case "$*" in *"\${FAIL_ON}"*) exit 1 ;; esac
fi
if [ -n "\${PROVIDES:-}" ]; then
    case "$*" in *"\${PROVIDES}"*)
        printf '#!%s\\necho "%s $*" >> "$CALL_LOG"\\nexit 0\\n' "$BASH" "\${PROVIDES}" > "\${STUB_DIR}/\${PROVIDES}"
        chmod +x "\${STUB_DIR}/\${PROVIDES}"
    ;; esac
fi
exit 0`;

const runScript = ({ env = {}, pm = 'dnf', omit = [], osRelease = null, files = {}, stubs = {} } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-build-env-test-'));
    try {
        const stubDir = path.join(dir, 'bin');
        fs.mkdirSync(stubDir);
        const callLog = path.join(dir, 'calls.log');
        fs.writeFileSync(callLog, '');
        for (const [name, body] of Object.entries({ ...stubBodies, [pm]: pmBody, ...stubs })) {
            if (omit.includes(name)) continue;
            const stubPath = path.join(stubDir, name);
            fs.writeFileSync(stubPath, `#!${bashPath}\necho "${name} $*" >> "$CALL_LOG"\n${body}\n`);
            fs.chmodSync(stubPath, 0o755);
        }
        for (const [name, toolPath] of Object.entries(realTools)) {
            if (toolPath && !fs.existsSync(path.join(stubDir, name))) {
                fs.symlinkSync(toolPath, path.join(stubDir, name));
            }
        }
        for (const [rel, content] of Object.entries(files)) {
            const filePath = path.join(dir, rel);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content);
        }
        const osReleasePath = path.join(dir, 'os-release');
        if (osRelease !== null) {
            fs.writeFileSync(osReleasePath, osRelease);
        }
        const githubPathFile = path.join(dir, 'github-path');
        let stdout;
        let code = 0;
        try {
            stdout = execFileSync(bashPath, [scriptPath], {
                encoding: 'utf8',
                stdio: 'pipe',
                cwd: dir,
                env: {
                    PATH: stubDir,
                    CALL_LOG: callLog,
                    STUB_DIR: stubDir,
                    OS_RELEASE: osReleasePath,
                    HOME: dir,
                    GITHUB_PATH: githubPathFile,
                    TOOLCHAIN: 'none',
                    ...env,
                },
            });
        } catch (err) {
            stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`;
            code = err.status ?? 1;
        }
        const calls = fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
        const githubPath = fs.existsSync(githubPathFile) ? fs.readFileSync(githubPathFile, 'utf8') : '';
        return { stdout, code, calls, githubPath };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

describe.skipIf(!bashPath)('setup-build-env.sh', () => {
    describe('repo enablement matrix', () => {
        it('enables EPEL and PowerTools on almalinux 8', () => {
            const { code, calls } = runScript({ env: { PLATFORM: 'almalinux8', SYSDEPS: 'libcurl-devel' } });
            expect(code).toBe(0);
            expect(calls).toContain('dnf install -y epel-release');
            expect(calls).toContain('dnf install -y --enablerepo=powertools libcurl-devel');
        });

        it('accepts the alma short id from platforms.json', () => {
            const { code, calls } = runScript({ env: { PLATFORM: 'alma8', SYSDEPS: 'libcurl-devel' } });
            expect(code).toBe(0);
            expect(calls).toContain('dnf install -y --enablerepo=powertools libcurl-devel');
        });

        it('enables CRB through microdnf on almalinux 9', () => {
            const { code, calls } = runScript({ pm: 'microdnf', env: { PLATFORM: 'almalinux9', SYSDEPS: 'libcurl-devel' } });
            expect(code).toBe(0);
            expect(calls).toContain('microdnf install -y epel-release');
            expect(calls).toContain('microdnf install -y --enablerepo=crb libcurl-devel');
        });

        it('enables CRB through yum on rocky 9', () => {
            const { code, calls } = runScript({ pm: 'yum', env: { PLATFORM: 'rocky9', SYSDEPS: 'libcurl-devel' } });
            expect(code).toBe(0);
            expect(calls).toContain('yum install -y --enablerepo=crb libcurl-devel');
        });

        it('enables CRB on centos 10', () => {
            const { calls } = runScript({ env: { PLATFORM: 'centos10', SYSDEPS: 'libcurl-devel' } });
            expect(calls).toContain('dnf install -y --enablerepo=crb libcurl-devel');
        });

        it('notices and installs without flags on an EL major without a recipe', () => {
            const { code, stdout, calls } = runScript({ env: { PLATFORM: 'almalinux7', SYSDEPS: 'libcurl-devel' } });
            expect(code).toBe(0);
            expect(stdout).toContain('no repo recipe for almalinux7');
            expect(calls).toContain('dnf install -y libcurl-devel');
            expect(calls.some(c => c.includes('epel-release'))).toBe(false);
        });

        it('installs EPEL from the Fedora mirror and enables CRB on rhel when present', () => {
            const crb = 'codeready-builder-for-rhel-9-x86_64-rpms';
            const { code, calls } = runScript({
                env: { PLATFORM: 'rhel9', SYSDEPS: 'libcurl-devel', REPOLIST_OUTPUT: `${crb}  disabled` },
            });
            expect(code).toBe(0);
            expect(calls).toContain('dnf install -y https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm');
            expect(calls).toContain(`dnf install -y --enablerepo=${crb} libcurl-devel`);
        });

        it('skips the CRB flag on rhel when the repo is not defined', () => {
            const { code, stdout, calls } = runScript({ env: { PLATFORM: 'rhel9', SYSDEPS: 'libcurl-devel' } });
            expect(code).toBe(0);
            expect(stdout).toContain('codeready-builder-for-rhel-9-x86_64-rpms not available');
            expect(calls).toContain('dnf install -y libcurl-devel');
        });

        it('warns and continues when EPEL cannot be installed on rhel', () => {
            const { code, stdout, calls } = runScript({
                env: { PLATFORM: 'rhel9', SYSDEPS: 'libcurl-devel', FAIL_ON: 'epel-release-latest', RPM_EXIT: '1' },
            });
            expect(code).toBe(0);
            expect(stdout).toContain('could not install EPEL on rhel9');
            expect(calls).toContain('dnf install -y libcurl-devel');
        });

        it('does nothing repo-wise on fedora', () => {
            const { code, stdout, calls } = runScript({ env: { PLATFORM: 'fedora42', SYSDEPS: 'libcurl-devel' } });
            expect(code).toBe(0);
            expect(stdout).not.toContain('::notice::');
            expect(calls).toContain('dnf install -y libcurl-devel');
            expect(calls.some(c => c.includes('epel'))).toBe(false);
        });

        it('notices unimplemented rpm distros and proceeds', () => {
            const { code, stdout, calls } = runScript({ env: { PLATFORM: 'amzn2023', SYSDEPS: 'libcurl-devel' } });
            expect(code).toBe(0);
            expect(stdout).toContain('repo enablement not implemented for amzn');
            expect(calls).toContain('dnf install -y libcurl-devel');
        });

        it('stays silent about repos on apt systems', () => {
            const { code, stdout, calls } = runScript({
                pm: 'apt-get',
                env: { PLATFORM: 'ubuntu24', SYSDEPS: 'libcurl4-openssl-dev' },
            });
            expect(code).toBe(0);
            expect(stdout).not.toContain('::notice::');
            expect(calls).toContain('apt-get update -qq');
            expect(calls).toContain('apt-get install -y --no-install-recommends libcurl4-openssl-dev');
        });

        it('rejects a malformed platform input', () => {
            const { code, stdout } = runScript({ env: { PLATFORM: 'almalinux', SYSDEPS: 'none' } });
            expect(code).not.toBe(0);
            expect(stdout).toContain('::error::');
            expect(stdout).toContain('malformed platform');
        });

        it('handles every linux_id_map distro id without failing', () => {
            for (const id of Object.keys(platforms.linux_id_map)) {
                const { code } = runScript({ env: { PLATFORM: `${id}9`, SYSDEPS: 'somepkg' } });
                expect(code, id).toBe(0);
            }
        });
    });

    describe('platform detection from os-release', () => {
        it('truncates VERSION_ID to the major version', () => {
            const { code, calls } = runScript({
                osRelease: 'ID="almalinux"\nVERSION_ID="8.10"\nPRETTY_NAME="AlmaLinux 8.10"\n',
                env: { SYSDEPS: 'libcurl-devel' },
            });
            expect(code).toBe(0);
            expect(calls).toContain('dnf install -y --enablerepo=powertools libcurl-devel');
        });

        it('falls back to the unimplemented-distro path when os-release is missing', () => {
            const { code, stdout, calls } = runScript({ env: { SYSDEPS: 'libcurl-devel' } });
            expect(code).toBe(0);
            expect(stdout).toContain('repo enablement not implemented for unknown');
            expect(calls).toContain('dnf install -y libcurl-devel');
        });
    });

    describe('list handling', () => {
        it('splits sysdeps_ignore across lines without globbing', () => {
            const { code, calls } = runScript({
                env: { PLATFORM: 'fedora42', SYSDEPS: 'auto', SYSDEPS_IGNORE: 'libfoo\n*' },
            });
            expect(code).toBe(0);
            expect(calls).toContain('rv sysdeps --json --only-absent --ignore libfoo --ignore *');
        });

        it('splits sysdeps_extra across lines', () => {
            const { code, calls } = runScript({
                env: { PLATFORM: 'fedora42', SYSDEPS: 'auto', SYSDEPS_EXTRA: 'extra1\nextra2' },
            });
            expect(code).toBe(0);
            expect(calls).toContain('dnf install -y extra1 extra2');
        });

        it('splits an explicit sysdeps list across lines without globbing', () => {
            const { code, calls } = runScript({
                env: { PLATFORM: 'fedora42', SYSDEPS: 'pkg1\npkg2 *' },
            });
            expect(code).toBe(0);
            expect(calls).toContain('dnf install -y pkg1 pkg2 *');
        });
    });

    describe('sysdeps=auto resolution', () => {
        it('emits the ambiguity notice even when extras are present', () => {
            const { code, stdout, calls } = runScript({
                env: { PLATFORM: 'fedora42', SYSDEPS: 'auto', SYSDEPS_EXTRA: 'extra1' },
            });
            expect(code).toBe(0);
            expect(stdout).toContain('no system dependencies resolved — either none are required, or this platform is not supported by rv sysdeps');
            expect(calls).toContain('dnf install -y extra1');
        });

        it('omits the notice when rv resolves packages', () => {
            const { code, stdout, calls } = runScript({
                env: { PLATFORM: 'fedora42', SYSDEPS: 'auto', JQ_OUTPUT: 'libxml2-devel\nlibcurl-devel' },
            });
            expect(code).toBe(0);
            expect(stdout).not.toContain('no system dependencies resolved');
            expect(calls).toContain('dnf install -y libxml2-devel libcurl-devel');
        });

        it('fails when jq fails', () => {
            const { code } = runScript({ env: { PLATFORM: 'fedora42', SYSDEPS: 'auto', JQ_EXIT: '1' } });
            expect(code).not.toBe(0);
        });

        it('fails when rv fails', () => {
            const { code } = runScript({ env: { PLATFORM: 'fedora42', SYSDEPS: 'auto', RV_EXIT: '1' } });
            expect(code).not.toBe(0);
        });

        it('warns and skips resolution when rv is not on PATH', () => {
            const { code, stdout, calls } = runScript({
                omit: ['rv'],
                env: { PLATFORM: 'fedora42', SYSDEPS: 'auto' },
            });
            expect(code).toBe(0);
            expect(stdout).toContain('sysdeps=auto requires rv on PATH');
            expect(calls.some(c => c.includes('install'))).toBe(false);
        });
    });

    describe('execution environment', () => {
        it('prefixes package-manager calls with sudo when not root', () => {
            const { code, calls } = runScript({
                env: { ID_U: '1000', PLATFORM: 'fedora42', SYSDEPS: 'pkg1' },
            });
            expect(code).toBe(0);
            expect(calls).toContain('sudo dnf install -y pkg1');
        });

        it('fails when not root and sudo is unavailable', () => {
            const { code, stdout } = runScript({ omit: ['sudo'], env: { ID_U: '1000' } });
            expect(code).not.toBe(0);
            expect(stdout).toContain('not running as root and sudo is unavailable');
        });

        it('fails when no supported package manager exists', () => {
            const { code, stdout } = runScript({ omit: ['dnf'] });
            expect(code).not.toBe(0);
            expect(stdout).toContain('no supported package manager');
        });
    });

    describe('toolchain and input validation', () => {
        it('installs the distro compiler set with toolchain=auto', () => {
            const { code, calls } = runScript({
                env: { TOOLCHAIN: 'auto', PLATFORM: 'fedora42', SYSDEPS: 'none' },
            });
            expect(code).toBe(0);
            expect(calls).toContain('dnf install -y gcc gcc-c++ gcc-gfortran make');
        });

        it('installs build-essential on apt systems with toolchain=auto', () => {
            const { code, calls } = runScript({
                pm: 'apt-get',
                env: { TOOLCHAIN: 'auto', PLATFORM: 'ubuntu24', SYSDEPS: 'none' },
            });
            expect(code).toBe(0);
            expect(calls).toContain('apt-get install -y --no-install-recommends build-essential gfortran');
        });

        it('rejects an unknown toolchain value', () => {
            const { code, stdout } = runScript({ env: { TOOLCHAIN: 'bogus' } });
            expect(code).not.toBe(0);
            expect(stdout).toContain('unknown toolchain value');
        });

        it('warns when ignore/extra are set outside sysdeps=auto', () => {
            const { code, stdout } = runScript({
                env: { PLATFORM: 'fedora42', SYSDEPS: 'none', SYSDEPS_EXTRA: 'extra1' },
            });
            expect(code).toBe(0);
            expect(stdout).toContain('only apply with sysdeps=auto');
        });
    });

    const rustupCurl = 'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs';
    const rustupSh = 'sh -s -- -y --default-toolchain stable --profile minimal';
    const rustEnv = { TOOLCHAIN: 'auto', SYSDEPS: 'none', PLATFORM: 'fedora42' };
    const noRustupCalls = (calls) => calls.every((c) => !c.startsWith('curl ') && !c.startsWith('sh '));

    describe('rust detection', () => {
        it('detects the rextendr layout via src/rust/Cargo.toml', () => {
            const { code, stdout, calls } = runScript({ env: rustEnv, files: { 'src/rust/Cargo.toml': '' } });
            expect(code).toBe(0);
            expect(stdout).toContain('Rust sources detected (src/rust/Cargo.toml)');
            expect(calls).toContain(rustupCurl);
            expect(calls).toContain(rustupSh);
        });

        it('detects a Cargo.toml anywhere under src/', () => {
            const { code, stdout, calls } = runScript({ env: rustEnv, files: { 'src/myext/Cargo.toml': '' } });
            expect(code).toBe(0);
            expect(stdout).toContain('Rust sources detected (src/myext/Cargo.toml)');
            expect(calls).toContain(rustupCurl);
        });

        for (const mk of ['src/Makevars', 'src/Makevars.in', 'src/Makevars.win.in']) {
            it(`detects a cargo mention in ${mk}`, () => {
                const { code, stdout, calls } = runScript({
                    env: rustEnv,
                    files: { [mk]: 'all:\n\tcargo build --release\n' },
                });
                expect(code).toBe(0);
                expect(stdout).toContain(`Rust sources detected (${mk} mentions cargo)`);
                expect(calls).toContain(rustupCurl);
            });
        }

        it('does not install Rust for C-only sources', () => {
            const { code, stdout, calls } = runScript({
                env: rustEnv,
                files: { 'src/foo.c': '', 'src/Makevars': 'PKG_CFLAGS = -O2\n' },
            });
            expect(code).toBe(0);
            expect(stdout).not.toContain('Rust sources detected');
            expect(noRustupCalls(calls)).toBe(true);
        });

        it('does not install Rust without a src directory', () => {
            const { code, stdout, calls } = runScript({ env: rustEnv });
            expect(code).toBe(0);
            expect(stdout).not.toContain('Rust sources detected');
            expect(noRustupCalls(calls)).toBe(true);
        });
    });

    describe('rust install mechanics', () => {
        it('appends the cargo bin dir to GITHUB_PATH', () => {
            const { code, githubPath } = runScript({ env: rustEnv, files: { 'src/rust/Cargo.toml': '' } });
            expect(code).toBe(0);
            expect(githubPath.trim().endsWith('/.cargo/bin')).toBe(true);
        });

        it('still installs with GITHUB_PATH unset', () => {
            const { code, calls, githubPath } = runScript({
                env: { ...rustEnv, GITHUB_PATH: '' },
                files: { 'src/rust/Cargo.toml': '' },
            });
            expect(code).toBe(0);
            expect(calls).toContain(rustupSh);
            expect(githubPath).toBe('');
        });

        it('skips the install when cargo is already on PATH', () => {
            const { code, stdout, calls } = runScript({
                env: rustEnv,
                files: { 'src/rust/Cargo.toml': '' },
                stubs: { cargo: 'exit 0' },
            });
            expect(code).toBe(0);
            expect(stdout).toContain('cargo already on PATH');
            expect(noRustupCalls(calls)).toBe(true);
        });

        it('notices detected Rust sources when toolchain=none', () => {
            const { code, stdout, calls } = runScript({
                env: { TOOLCHAIN: 'none', SYSDEPS: 'none', PLATFORM: 'fedora42' },
                files: { 'src/rust/Cargo.toml': '' },
            });
            expect(code).toBe(0);
            expect(stdout).toContain('Rust sources detected but toolchain=none');
            expect(noRustupCalls(calls)).toBe(true);
        });

        it('installs curl with the package manager before rustup when missing', () => {
            const { code, calls } = runScript({
                omit: ['curl'],
                env: { ...rustEnv, PROVIDES: 'curl' },
                files: { 'src/rust/Cargo.toml': '' },
            });
            expect(code).toBe(0);
            const installIndex = calls.indexOf('dnf install -y curl');
            const curlIndex = calls.indexOf(rustupCurl);
            expect(installIndex).toBeGreaterThanOrEqual(0);
            expect(curlIndex).toBeGreaterThan(installIndex);
        });
    });

    describe('darwin', () => {
        it('installs rustup without touching a package manager', () => {
            const { code, stdout, calls } = runScript({
                env: { UNAME_S: 'Darwin', TOOLCHAIN: 'auto' },
                files: { 'src/rust/Cargo.toml': '' },
            });
            expect(code).toBe(0);
            expect(calls).toContain(rustupCurl);
            expect(calls).toContain(rustupSh);
            expect(calls.some((c) => /^(dnf|sudo|id) /.test(c))).toBe(false);
            expect(stdout).toContain('skipping on Darwin');
        });

        it('skips the install when the runner ships cargo', () => {
            const { code, stdout, calls } = runScript({
                env: { UNAME_S: 'Darwin', TOOLCHAIN: 'auto' },
                files: { 'src/rust/Cargo.toml': '' },
                stubs: { cargo: 'exit 0' },
            });
            expect(code).toBe(0);
            expect(stdout).toContain('cargo already on PATH');
            expect(noRustupCalls(calls)).toBe(true);
        });

        it('exits cleanly without rust sources', () => {
            const { code, stdout, calls } = runScript({ env: { UNAME_S: 'Darwin', TOOLCHAIN: 'auto' } });
            expect(code).toBe(0);
            expect(stdout).toContain('package-manager toolchain/sysdeps only apply to linux; skipping on Darwin');
            expect(noRustupCalls(calls)).toBe(true);
        });

        it('rejects an unknown toolchain value', () => {
            const { code, stdout } = runScript({ env: { UNAME_S: 'Darwin', TOOLCHAIN: 'bogus' } });
            expect(code).not.toBe(0);
            expect(stdout).toContain('unknown toolchain value');
        });

        it('warns when a vendored archive needs xz', () => {
            const { code, stdout } = runScript({
                env: { UNAME_S: 'Darwin', TOOLCHAIN: 'auto' },
                files: { 'src/rust/vendor.tar.xz': '' },
            });
            expect(code).toBe(0);
            expect(stdout).toContain('vendor.tar.xz present but xz is not on PATH');
        });

        it('stays quiet about xz when it is available', () => {
            const { code, stdout } = runScript({
                env: { UNAME_S: 'Darwin', TOOLCHAIN: 'auto' },
                files: { 'src/rust/vendor.tar.xz': '' },
                stubs: { xz: 'exit 0' },
            });
            expect(code).toBe(0);
            expect(stdout).not.toContain('::warning::');
        });
    });

    describe('windows', () => {
        it('is a no-op even with rust sources', () => {
            const { code, stdout, calls } = runScript({
                env: { UNAME_S: 'MINGW64_NT-10.0-20348', TOOLCHAIN: 'auto' },
                files: { 'src/rust/Cargo.toml': '' },
            });
            expect(code).toBe(0);
            expect(stdout).toContain('nothing to do on MINGW64_NT-10.0-20348');
            expect(calls).toEqual(['uname -s']);
        });
    });

    describe('vendored crate xz on linux', () => {
        const vendorFiles = { 'src/rust/vendor.tar.xz': '' };

        it('installs xz for a vendored crate archive', () => {
            const { code, calls } = runScript({ env: rustEnv, files: vendorFiles });
            expect(code).toBe(0);
            expect(calls).toContain('dnf install -y xz');
        });

        it('installs xz-utils on apt systems', () => {
            const { code, calls } = runScript({
                pm: 'apt-get',
                env: { ...rustEnv, PLATFORM: 'ubuntu24' },
                files: vendorFiles,
            });
            expect(code).toBe(0);
            expect(calls).toContain('apt-get install -y --no-install-recommends xz-utils');
        });

        it('installs xz on zypper systems', () => {
            const { code, calls } = runScript({
                pm: 'zypper',
                env: { ...rustEnv, PLATFORM: 'opensuse15' },
                files: vendorFiles,
            });
            expect(code).toBe(0);
            expect(calls).toContain('zypper --non-interactive install xz');
        });

        it('does not install xz without the vendor archive', () => {
            const { code, calls } = runScript({ env: rustEnv, files: { 'src/rust/Cargo.toml': '' } });
            expect(code).toBe(0);
            expect(calls.some((c) => c.includes('xz'))).toBe(false);
        });

        it('does not install xz when toolchain=none', () => {
            const { code, calls } = runScript({
                env: { TOOLCHAIN: 'none', SYSDEPS: 'none', PLATFORM: 'fedora42' },
                files: vendorFiles,
            });
            expect(code).toBe(0);
            expect(calls.some((c) => c.includes('xz'))).toBe(false);
        });

        it('skips the install when xz is already on PATH', () => {
            const { code, calls } = runScript({ env: rustEnv, files: vendorFiles, stubs: { xz: 'exit 0' } });
            expect(code).toBe(0);
            expect(calls.some((c) => c.includes('install') && c.includes('xz'))).toBe(false);
        });
    });
});
