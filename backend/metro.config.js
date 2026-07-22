const { getDefaultConfig } = require("expo/metro-config");
const exclusionList = require("metro-config/src/defaults/exclusionList");

const config = getDefaultConfig(__dirname);

const existingBlockList = Array.isArray(config.resolver.blockList)
  ? config.resolver.blockList
  : [config.resolver.blockList].filter(Boolean);

config.resolver.blockList = exclusionList([...existingBlockList, /backend[\\/].*/]);

module.exports = config;