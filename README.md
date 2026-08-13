# r-releaser

GitHub Actions for building R packages into source tarballs and platform binaries, describing them in a metadata manifest, and deploying them to [PRISM](docs/prism-model.md), A2-ai's R package manager.

These actions are consumed by the workflow templates in [A2-ai/r-package-workflows](https://github.com/A2-ai/r-package-workflows). A typical release run sequences them as:

```
build-src ──► build-bin (once per platform) ──► merge-manifests ──► deploy-prism ──► create-edition / update-edition
```

## Actions

### setup-build-env

Prepares the build environment before `rv sync` runs: installs the
distro's compiler toolchain (`toolchain: auto`, or `none` to skip) and system
libraries (`sysdeps: auto` resolves them with `rv sysdeps`; `none` skips; a
space-separated package list installs exactly those). With `auto`,
`sysdeps_ignore` names dependencies to pass as `--ignore` flags (for rules the
database resolves to nonexistent package names) and `sysdeps_extra` names
packages to install in addition (for requirements the database omits). Before
installing system libraries on an EL clone (AlmaLinux/Rocky/CentOS), EPEL is
installed and the builder repo (PowerTools on EL8, CRB on EL9+) is enabled for
that install; on RHEL/UBI both are best-effort — EPEL comes from the Fedora
mirror and CRB is enabled only if the system defines it. An empty `auto` result is
ambiguous and annotated as such: either nothing is required, or the platform
is unsupported by `rv sysdeps` (almalinux10 and native Rocky are known
unsupported). Detects dnf/microdnf/yum/apt-get/zypper and uses sudo only when
not root. The distro toolchain and system libraries are linux-only; with
`toolchain: auto`, rustup (stable toolchain, minimal profile) and xz install
on linux and macOS unless `rust: none` — a dependency compiled from source
during `rv sync` may need them, which is unknowable up front. With
`rust: none`, xz still installs when `src/rust/vendor.tar.xz` is present.
No-op on Windows.

### build-src

Rewrites `DESCRIPTION` in the working directory with caller metadata (plus `GitOrigin`/`GitSHA`), strips `Remotes:`, runs `R CMD build .`, and writes a `source` manifest entry.

| Input | Default | Notes |
|---|---|---|
| `library` | required | R library path for the build (`R_LIBS_SITE`/`R_LIBS_USER`) |
| `metadata` | `{}` | JSON object of scalar fields merged into `DESCRIPTION` and the manifest |
| `build-vignettes` / `resave-data` / `md5` | `true` | Map to the corresponding `R CMD build` flags |
| `user` | — | Passed as `--user=<user>` |
| `manifest_path` | `manifest.json` | Where the manifest entry is written |

Outputs: `tarball_path`, `tarball_name`, `manifest_path`, `linking_to_deps` (JSON array parsed from `LinkingTo`).

### build-bin

Runs `R CMD INSTALL --build` on the source tarball, names the product `{pkg}_{ver}_{platform}_{arch}_{rminor}{ext}`, resolves each `LinkingTo` dependency's version from the installed library, and **merges** a `binary` entry into the manifest (an existing manifest at `manifest_path` is preserved, not overwritten).

The platform tag embeds the `/etc/os-release` `ID` plus major version (e.g. `linux_almalinux8`). Building on a distro that is not listed in [`shared/platforms.json`](shared/platforms.json) fails immediately, because `deploy-prism` would be unable to map the binary later.

On linux, every shared object in the installed package is verified against the [portability contract](docs/portability-contract.md) (a static `readelf` read of `DT_NEEDED`), and the result is recorded in the manifest as `no_sys_deps`, alongside the highest required `GLIBC_` version as `glibc_max`. When verification cannot run, a claimed build fails and an unclaimed build warns and records neither field.

| Input | Default | Notes |
|---|---|---|
| `src_tarball_path` | required | Source tarball from build-src |
| `library` | required | Library containing the package's dependencies |
| `linking_to_deps` | `[]` | JSON array from build-src's `linking_to_deps` output |
| `include_builtin_linking_to_deps` | `false` | When `true`, base/recommended packages ([`builtin_packages.json`](build-bin/builtin_packages.json)) are included in `linked_to`; excluded otherwise |
| `no_sys_deps` | `false` | Claims binary portability per the [portability contract](docs/portability-contract.md); the build fails when the claim is violated or cannot be verified. Linux-only; ignored with a warning elsewhere |
| `manifest_path` | `manifest.json` | Merged into, not replaced |

Outputs: `binary_path`, `binary_name`, `manifest_path`.

### build-docs

Builds the package's [pkgdown](https://pkgdown.r-lib.org) site with `Rscript`, tars the resulting `docs/` directory into `{package}_{version}_docs.tar.gz`, and **merges** a `docs` entry into the manifest.

Any `_pkgdown.yml` found under `working_dir` is normalized first: `url`, `template`, `redirects` and `destination` are stripped and `template: {bootstrap: 5}` is prepended, because PRISM serves the site inside its own chrome and at its own paths. A package without a `_pkgdown.yml` gets a minimal one. `pkgdown::build_site` is retried with `examples = FALSE` if the first attempt fails, and the compressed tarball is rejected above 200 MB — the limit the docs endpoint accepts.

| Input | Default | Notes |
|---|---|---|
| `library` | required | R library path holding pkgdown and the package's dependencies |
| `working_dir` | `.` | Package source root (where `DESCRIPTION` lives) |
| `repo_url` | `''` | Value for R's `repos` option during the build |
| `manifest_path` | `manifest.json` | Merged into, not replaced |
| `asset_name` | `{package}_{version}_docs.tar.gz` | Release asset name and manifest key, so it must not collide with the source tarball or any binary |

Outputs: `docs_tarball_path`, `docs_tarball_name`, `manifest_path`.

### merge-manifests

Collects per-job manifests (uploaded as workflow artifacts) from `manifest_dir` matching `manifest_glob`, merges them, validates the result against the [manifest schema](shared/schemas/manifest.schema.json), and writes `manifest.json` at the workspace root. Conflicting duplicate keys fail the merge; identical duplicates are tolerated.

### deploy-prism

Downloads all assets of a GitHub Release, validates `manifest.json` (which must be one of the assets), rewrites each binary's embedded `DESCRIPTION` with canonical `OS`/`Arch`/`LinkedTo` fields, and uploads every asset to `{prism_api_url}/packages`. Assets whose manifest entry is a `docs` entry go to `{prism_api_url}/documents/{package}/versions/{version}` instead, with the same raw `application/octet-stream` body (`no_sys_deps`/`force` never apply to them); an asset with no manifest entry is still posted to `/packages`. Retries 429/5xx/network errors with doubling backoff; 409 responses count as idempotent success (a `covered_by_existing` 409 warns and can be resolved with `force: true` alongside `no_sys_deps`).

Key inputs: `prism_api_url`, `auth_token`, `release_tag` (required); `package_name`, `retry_count`, `dry_run`, `skip` (comma-OR/plus-AND rules over os/os_codename/r_version), `no_sys_deps`, `force`.

`?no_sys_deps=true` is sent only when the `no_sys_deps` input is true **and** the asset's manifest entry records `no_sys_deps: true` from build-bin's verifier; a manifest recording `false` or lacking the field (older build-bin, or build-time verification could not run) warns and uploads unflagged.

### create-edition

Ensures an "individual package" registry named after the package exists, then creates an **immutable** edition `{package}/{version}` (optionally `?latest=true`). Exits successfully if the edition already exists.

### update-edition

GET-modify-PUT of an existing **mutable** edition: bumps this package's version, drops its `linkedToHash` so the server re-resolves binaries, and preserves everything else. It can only bump a package that is already a member of the edition — it cannot add one. Retries the whole GET→PUT cycle on 429/5xx/network errors (`retry_count`, default 3).

## The manifest

`manifest.json` is a JSON object keyed by release-asset filename, defined by [`shared/schemas/manifest.schema.json`](shared/schemas/manifest.schema.json) and validated at merge and deploy time by the dependency-free checker in [`shared/manifest-schema.js`](shared/manifest-schema.js). Source entries carry provenance metadata (`GitOrigin`, `GitSHA`, `PrismRemote*`); binary entries carry `os`, `os_codename`, `arch`, `r_version`, and `linked_to`, plus the optional portability fields `no_sys_deps` and `glibc_max` on linux builds; docs entries are just `package`, `version`, and `type: "docs"`, which is how deploy-prism knows to route the asset to the docs endpoint.

## Development

```sh
npm ci          # single workspace install (shared, build-src, build-bin, build-docs, merge-manifests)
npm test        # vitest across all packages
npm run bundle  # rebuild every action's dist/ with ncc — commit the result
```

CI enforces tests, up-to-date `dist/` bundles, and actionlint. The JS actions run from their ncc bundles (`dist/index.js`); `deploy-prism/prepare-binaries.js` runs unbundled and therefore must not require anything outside `node:` builtins and `../shared`.

## Versioning

Consumers reference these actions as `@deploy-prism`, and new work merges into that branch, so changes reach consumers on their next workflow run. Semver tags (`v1.0.0` with a moving `v1` major tag) may be introduced later once the release process stabilizes.
