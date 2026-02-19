// debug.js
process.env.INPUT_LIBRARY = "/Users/rob/workspace/git/r-releaser/rv/library/4.4/arm64";
process.env.INPUT_METADATA = JSON.stringify({

});
// process.env.INPUT_SRC_TARBALL_PATH = "/path/to/your/source/tarball.tar.gz";
process.env.INPUT_SRC_TARBALL_PATH = "/Users/rob/workspace/git/r-releaser/dplyr_1.2.0.tar.gz";
// Now run your action code
require('./index.js');