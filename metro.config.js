const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Keep Metro's watcher/bundler out of backend/ entirely — it's a separate
// Node/Express project with its own huge node_modules tree that has nothing
// to do with the RN app. Without this, Metro crawls backend/node_modules on
// every `expo start`, which slows dev-server startup and can surface bogus
// module-resolution/watcher errors.
//
// Note: resolver.blockList natively accepts a RegExp or an array of RegExp
// (see metro-config's types.d.ts), so we just append to it directly rather
// than pulling in metro-config's "exclusionList" helper — that helper lives
// under a private src/ path that current metro-config versions no longer
// expose via package.json "exports", which breaks `require()` entirely.
const existingBlockList = Array.isArray(config.resolver.blockList)
  ? config.resolver.blockList
  : [config.resolver.blockList].filter(Boolean);

config.resolver.blockList = [...existingBlockList, /backend[\\/].*/];

module.exports = config;
