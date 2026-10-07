// The tests run the real git, and a contributor's own config reached every
// fixture commit through it: a global `commit.gpgsign=true` with a key the
// test cannot use failed three dozen of them. Each test file's git reads no
// config but what the test gives it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
