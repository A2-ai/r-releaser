# The portability contract

What `no_sys_deps` promises, how build-bin verifies it, and exactly which shared
libraries a portable binary may link. This is the contract behind build-bin's
`no_sys_deps` input and the `no_sys_deps` / `glibc_max` manifest fields.

## What the claim means

`POST /packages?no_sys_deps=true` declares a linux binary portable along the glibc
axis: PRISM serves it to every supported distro whose glibc is at least the build
distro's (see [prism-model.md](prism-model.md)). That collapses the linux side of the
build matrix to one build per architecture. The claim asserts that the binary's
shared objects require nothing beyond what a bare supported distro plus an R
installation provides.

The failure modes are asymmetric. A missing build-time dependency fails the compile:
loud, local, diagnosable. A false portability claim ships a binary that PRISM serves
to every distro above that glibc, failing as a load error in someone else's R session
on a distro nobody tested. This contract exists to guard the second case.

## Mechanism

For every shared object (`*.so`, including versioned names like `*.so.2`) anywhere
under the installed package's directory — not just `libs/`, since packages also ship
objects via `inst/` — build-bin runs `readelf -dV` and reads:

- **`DT_NEEDED`** entries from the dynamic section — the object's *declared, direct*
  shared-library dependencies. This is a static read; nothing is executed.
- **Version-needed records** (`.gnu.version_r`) — the symbol versions the object
  requires from those libraries.

`ldd` is deliberately not used: it invokes the dynamic loader against the object and
reports the transitive closure. Direct declarations are the actual question, and a
static read executes nothing.

## Library classes

| Class | SONAMEs | Treatment |
| --- | --- | --- |
| glibc family | `libc.so.6`, `libm.so.6`, `libdl.so.2`, `libpthread.so.0`, `librt.so.1`, `libresolv.so.2`, `libutil.so.1`, `ld-linux-*.so.*` (any architecture) | **Allowed.** Portability within the family is governed by the glibc floor PRISM already models from build provenance. |
| GCC unwind runtime | `libgcc_s.so.1` | **Allowed.** Stable ABI, present wherever glibc is. |
| R family | `libR.so`, `libRblas.so`, `libRlapack.so` | **Allowed.** Supplied by the R installation the binary targets. |
| Compiler runtimes | `libstdc++.so.6`, `libgfortran.so.*`, `libgomp.so.*` | **System dependencies — violation.** See below. |
| Everything else | `libcurl.so.4`, `libxml2.so.2`, `libssl.so.*`, … | **System dependencies — violation.** |

### Why the compiler runtimes are excluded

SONAME presence proves nothing about symbol-version floors. A binary built on alma9
links `libstdc++.so.6` exactly as one built on alma8 does, while requiring a
`GLIBCXX_` version alma8's copy does not export — and the same failure exists without
crossing distros: build on alma8 with `gcc-toolset-13` and the object requires
`GLIBCXX_3.4.32`, which alma8's own system `libstdc++.so.6` does not provide. Nothing
currently models per-distro capabilities for `GLIBCXX_` / `CXXABI_` / `GFORTRAN_` /
`GOMP_`+`OMP_` the way PRISM models the glibc floor, so treating these libraries as
system dependencies is the only answer that cannot be wrong in the dangerous
direction.

The cost is accepted knowingly: every Rcpp-based package links `libstdc++.so.6`, so
most compiled packages are ineligible for `no_sys_deps` until a generated per-distro
capability table exists to check symbol-version requirements against (the planned
follow-on).

## Rules

- **Direct dependencies only.** Only the object's own `DT_NEEDED` entries are
  checked. What the allowed libraries themselves link is resolved by the target
  distro's package manager.
- **Every object must pass.** A package may ship multiple `.so` files; the claim
  holds only if all of them do. All objects are inspected before failing, so one
  failure message names every violation.
- **`glibc_max` is informational.** The highest `GLIBC_x.y` version required across
  all objects is recorded in the manifest. It is not a gate — an object cannot
  require more than the build distro's glibc provides, which PRISM's provenance-based
  floor already models — but it records the measured floor for future capability
  matching.
- **`dlopen` is invisible.** A library loaded at runtime via `dlopen` appears in no
  static read. For that class the claim remains the packager's assertion; this
  contract cannot verify it.

## Scope and failure semantics

The contract applies to linux binaries only. deploy-prism never flags source or
non-linux uploads, and a `no_sys_deps` claim on a non-linux build-bin run is ignored
with a warning.

On linux, build-bin always attempts verification. When it runs, the result
(`no_sys_deps: true|false`, plus `glibc_max` when any `GLIBC_` requirement was seen)
is recorded in the binary's manifest entry; when it cannot run, a claimed build
fails and an unclaimed build records neither field. The `no_sys_deps` input controls
gating only:

| Claimed | Verification result | Outcome |
| --- | --- | --- |
| yes | violations found | **Build fails**, naming every object and library. |
| yes | cannot run (`readelf` missing or erroring, unreadable output) | **Build fails.** An unverifiable claim is a rejected claim. |
| yes | clean | Build passes with a notice; manifest records `no_sys_deps: true`. |
| no | violations found | Build passes; manifest records `no_sys_deps: false`. |
| no | cannot run | Build passes with a warning; no portability fields written (absent means unknown). |
| no | clean | Build passes with a notice that the package is eligible for `no_sys_deps`. |

deploy-prism sends `?no_sys_deps=true` only when its own `no_sys_deps` input is true
**and** the manifest entry confirms `no_sys_deps: true`. A manifest recording `false`,
or lacking the field (built by an older build-bin, or an unclaimed build where
verification could not run), produces a warning and the flag is not sent — the upload
proceeds unflagged and serves per-distro.
