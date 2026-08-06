# PRISM data model, as used by r-releaser

PRISM is A2-ai's R package manager. Nothing in this repo owns PRISM's API, but the actions here are its primary write-path client, so the mental model matters. This page documents the subset these actions touch — inferred from the API interactions and confirmed behavior, not from a PRISM spec.

## Packages

Uploaded artifacts (source tarballs and platform binaries) live in a flat package store. `deploy-prism` POSTs each release asset to `POST {api}/packages` with a bearer token, `Content-Type: application/octet-stream`, and an `X-Filename` header. PRISM identifies binaries by the metadata embedded in their `DESCRIPTION` (`OS`, `Arch`, `LinkedTo`) — which is why `prepare-binaries.js` rewrites those fields before upload, mapping manifest values to PRISM's vocabulary (`alma8` → `almalinux 8`, `x64` → `x86_64`, `linked_to` → `Rcpp (== 1.0.11), ...`).

A 409 on upload means the package (or a covering equivalent) is already present and is treated as success. `?no_sys_deps=true` (linux binaries only) tells PRISM the binary was built without system dependency resolution; `&force=true` may accompany it to replace an existing covering package.

## Registries

A **registry** is a namespace for editions. `create-edition` auto-provisions a registry named after the package with `registry_type: "individual package"`. Shared registries (e.g. a team-wide `hyperion-eco`) are created out-of-band and hold multi-package editions.

- `GET/POST {api}/registries/{name}`

## Editions

An **edition** is a named, resolved snapshot inside a registry: a list of `{name, version}` packages plus a `platforms` list (`{os, r_version, codename, architecture}`) describing which binaries it serves.

- `GET/POST {api}/registries/{registry}/editions/{edition}` (`?latest=true` on POST to enter the latest-history)
- `PUT {api}/registries/{registry}/editions/{edition}` (`?force=true` to bypass immutability/linkedToHash verification)

Two kinds, by the `mutable` flag:

| | Immutable (`mutable: false`) | Mutable |
|---|---|---|
| Purpose | Permanent snapshot of one package release, e.g. `mypkg/1.2.0` | Rolling channel, e.g. `hyperion-eco/dev` |
| Created by | `create-edition`, one per release | Out-of-band (platform team) |
| Changed by | Never (except `PUT ?force=true`) | `update-edition` bumping one member's version |

### linkedToHash

Per package, per R version, PRISM pins which compiled binary satisfies a `LinkingTo` relationship via a `linkedToHash` map (`r_version → hash`). On `GET` it arrives as that map; a `PUT` body wants it as an array of `{r_version, hash}`. `update-edition` preserves other packages' hashes verbatim but **drops** the updated package's hash so the server re-resolves it against the freshly uploaded binaries. A hash-verification failure on PUT can be bypassed with `force`, at the cost of skipping that safety check.

## Known constraints

- `update-edition` cannot add a package to an edition — the API accepts membership changes only through other channels, so the action hard-errors if the package isn't already a member. First-time inclusion in a shared edition is a manual step.
- Edition updates are read-modify-write with no conditional-update mechanism (no ETag/If-Match). Two concurrent `update-edition` runs against the same edition can lose one update; the retry loop narrows but does not close that window. Serialize deploys into a shared edition (e.g. a per-edition concurrency group in the calling workflow).
- The `latest` flag on edition creation is append-only history; there is no API here for demoting a latest edition.
