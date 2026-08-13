const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Maximum compressed tarball size the PRISM docs endpoint accepts (200 MB).
const MAX_TARBALL_BYTES = 200 * 1024 * 1024;

// pkgdown driver script, run with Rscript and 5 positional args:
// <pkg> <ver> <working_dir> <lib_path> <repo_url>.
//
// The _pkgdown.yml normalization stays in R rather than JS because `yaml` is
// already available in the build library, and reimplementing YAML round-tripping
// in the action would be worse. PRISM renders these docs inside its own chrome
// and at its own paths, so `url`, `template`, `redirects` and `destination` are
// dropped and bootstrap 5 is forced — anything the package declared there would
// either break navigation or be ignored.
const PKGDOCS_BUILD_R = `args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 5) {
  stop("expected: <pkg> <ver> <working_dir> <lib_path> <repo_url>")
}
pkg_name <- args[1]
ver <- args[2]
working_dir <- args[3]
lib_path <- args[4]
repo_url <- args[5]

.libPaths(lib_path)
library(yaml)

found_yml_files <- list.files(
  path = working_dir,
  pattern = "_pkgdown.yml$",
  full.names = TRUE,
  recursive = TRUE
)
if (length(found_yml_files) > 0) {
  yml_path <- found_yml_files[1]
  message("Found _pkgdown.yml at: ", yml_path)
  pkgdownyml <- read_yaml(yml_path)
  pkgdownyml <- pkgdownyml[!names(pkgdownyml) %in% c("url", "template", "redirects", "destination")]
  pkgdownyml <- c(list(template = list(bootstrap = 5L)), pkgdownyml)
  write_yaml(pkgdownyml, yml_path)
} else {
  yml_path <- file.path(working_dir, "_pkgdown.yml")
  pkgdownyml <- list(template = list(bootstrap = 5L))
  write_yaml(pkgdownyml, yml_path)
  message("Created minimal _pkgdown.yml at: ", yml_path)
}

withr::with_libpaths(lib_path, {
  # repo_url is optional: a caller whose library is already fully synced (rv, for
  # instance) has no repository to name. Blanking the repos option would then be
  # worse than leaving it alone, so only set it when one was actually passed.
  if (nzchar(repo_url)) {
    options(repos = repo_url)
  }
  withr::with_envvar(new = c("R_LIBS" = lib_path), {
    result <- tryCatch({
      pkgdown::build_site(working_dir)
      "ok"
    }, error = function(e) {
      message("build_site with examples failed: ", conditionMessage(e))
      message("Retrying with examples = FALSE")
      pkgdown::build_site(working_dir, examples = FALSE)
      "ok-no-examples"
    })
    message("build_site result: ", result)
  })
})

print("Session info:")
sessionInfo()
`;

// The asset name is both the release asset name and the manifest key, so it has
// to be unique per package/version and distinct from the source tarball and any
// binary.
function defaultAssetName(pkgName, pkgVersion) {
    return `${pkgName}_${pkgVersion}_docs.tar.gz`;
}

function writeBuildScript(dir) {
    const targetDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'build-docs-'));
    const scriptPath = path.join(targetDir, 'pkgdocs-build.R');
    fs.writeFileSync(scriptPath, PKGDOCS_BUILD_R);
    return scriptPath;
}

function buildSite(pkgName, pkgVersion, workingDir, libraryPath, repoUrl) {
    const scriptPath = writeBuildScript();
    const args = [scriptPath, pkgName, pkgVersion, workingDir, libraryPath, repoUrl];

    console.log(`Running "Rscript ${args.join(' ')}"`);

    const result = spawnSync('Rscript', args, { stdio: 'pipe', encoding: 'utf8' });
    if (result.error) {
        throw Error(`Failed to start Rscript: ${result.error.message}`);
    }
    // pkgdown logs progress to stderr, so it is worth printing even on success.
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.log(result.stderr);
    if (result.status !== 0) {
        throw Error(`pkgdown::build_site exited with ${result.status}:\n${result.stderr}`);
    }
}

function tarDocs(docsDir, tarballPath) {
    const result = spawnSync('tar', ['-czf', tarballPath, '-C', docsDir, '.'], {
        stdio: 'pipe',
        encoding: 'utf8',
        // COPYFILE_DISABLE=1 stops macOS bsd-tar from emitting AppleDouble
        // `._*` sidecars from extended attributes.
        env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    if (result.error) {
        throw Error(`Failed to start tar: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw Error(`tar exited with ${result.status}:\n${result.stderr}`);
    }
    return tarballPath;
}

// The server rejects anything above the cap, so fail here with the real size
// rather than after a long upload.
function checkTarballSize(tarballPath) {
    const size = fs.statSync(tarballPath).size;
    if (size > MAX_TARBALL_BYTES) {
        throw Error(`Docs tarball is ${size} bytes, which exceeds the 200 MB cap accepted by PRISM`);
    }
    return size;
}

module.exports = {
    MAX_TARBALL_BYTES,
    PKGDOCS_BUILD_R,
    defaultAssetName,
    writeBuildScript,
    buildSite,
    tarDocs,
    checkTarballSize,
};
