# r-releaser

GitHub Actions for building R packages into source tarballs and platform binaries, describing them in a metadata manifest, and deploying them to [PRISM](docs/prism-model.md), A2-ai's R package manager.

These actions are consumed by the workflow templates in [A2-ai/r-package-workflows](https://github.com/A2-ai/r-package-workflows). A typical release run sequences them as:

```
build-src ──► build-bin (once per platform) ──► merge-manifests ──► deploy-prism ──► create-edition / update-edition
```

## Actions

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

| Input | Default | Notes |
|---|---|---|
| `src_tarball_path` | required | Source tarball from build-src |
| `library` | required | Library containing the package's dependencies |
| `linking_to_deps` | `[]` | JSON array from build-src's `linking_to_deps` output |
| `include_builtin_linking_to_deps` | `false` | When `true`, base/recommended packages ([`builtin_packages.json`](build-bin/builtin_packages.json)) are included in `linked_to`; excluded otherwise |
| `manifest_path` | `manifest.json` | Merged into, not replaced |

Outputs: `binary_path`, `binary_name`, `manifest_path`.

### merge-manifests

Collects per-job manifests (uploaded as workflow artifacts) from `manifest_dir` matching `manifest_glob`, merges them, validates the result against the [manifest schema](shared/schemas/manifest.schema.json), and writes `manifest.json` at the workspace root. Conflicting duplicate keys fail the merge; identical duplicates are tolerated.

### deploy-prism

Downloads all assets of a GitHub Release, validates `manifest.json` (which must be one of the assets), rewrites each binary's embedded `DESCRIPTION` with canonical `OS`/`Arch`/`LinkedTo` fields, and uploads every asset to `{prism_api_url}/packages`. Retries 429/5xx/network errors with doubling backoff; 409 responses count as idempotent success (a `covered_by_existing` 409 warns and can be resolved with `force: true` alongside `no_sys_deps`).

Key inputs: `prism_api_url`, `auth_token`, `release_tag` (required); `package_name`, `retry_count`, `dry_run`, `skip` (comma-OR/plus-AND rules over os/os_codename/r_version), `no_sys_deps`, `force`.

### create-edition

Ensures an "individual package" registry named after the package exists, then creates an **immutable** edition `{package}/{version}` (optionally `?latest=true`). Exits successfully if the edition already exists.

### update-edition

GET-modify-PUT of an existing **mutable** edition: bumps this package's version, drops its `linkedToHash` so the server re-resolves binaries, and preserves everything else. It can only bump a package that is already a member of the edition — it cannot add one. Retries the whole GET→PUT cycle on 429/5xx/network errors (`retry_count`, default 3).

## The manifest

`manifest.json` is a JSON object keyed by release-asset filename, defined by [`shared/schemas/manifest.schema.json`](shared/schemas/manifest.schema.json) and validated at merge and deploy time by the dependency-free checker in [`shared/manifest-schema.js`](shared/manifest-schema.js). Source entries carry provenance metadata (`GitOrigin`, `GitSHA`, `PrismRemote*`); binary entries carry `os`, `os_codename`, `arch`, `r_version`, and `linked_to`.

## Development

```sh
npm ci          # single workspace install (shared, build-src, build-bin, merge-manifests)
npm test        # vitest across all packages
npm run bundle  # rebuild every action's dist/ with ncc — commit the result
```

CI enforces tests, up-to-date `dist/` bundles, and actionlint. The JS actions run from their ncc bundles (`dist/index.js`); `deploy-prism/prepare-binaries.js` runs unbundled and therefore must not require anything outside `node:` builtins and `../shared`.

## Versioning

Consumers currently reference these actions as `@deploy-prism`. That branch is frozen; new work lands on `main`, which will be tagged `v1.0.0` (with a moving `v1` major tag) once the hardening phase is signed off.
