const { getDefaultConfig } = require("expo/metro-config");
const exclusionList = require("metro-config/src/defaults/exclusionList");

const config = getDefaultConfig(__dirname);

// Keep Metro's watcher/bundler out of backend/ entirely — it's a separate
// Node/Express project with its own huge node_modules tree that has nothing
// to do with the RN app. Without this, Metro crawls backend/node_modules on
// every `expo start`, which slows dev-server startup and can surface bogus
// module-resolution/watcher errors.
const existingBlockList = Array.isArray(config.resolver.blockList)
  ? config.resolver.blockList
  : [config.resolver.blockList].filter(Boolean);

config.resolver.blockList = exclusionList([...existingBlockList, /backend[\\/].*/]);

module.exports = config;
