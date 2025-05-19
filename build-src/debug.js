// debug.js
process.env.INPUT_LIBRARY = "/path/to/your/library";
process.env.INPUT_METADATA = JSON.stringify({
    repositorY: "Dummy",
    added: 100
});
process.env.GITHUB_SHA = "somesha";
process.env["INPUT_BUILD-VIGNETTES"] = "true";
process.env["INPUT_RESAVE-DATA"] = "true";
process.env.INPUT_MD5 = "true";

// Now run your action code
require('./index.js');