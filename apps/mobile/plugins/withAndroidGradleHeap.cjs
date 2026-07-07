"use strict";

// Raises the Android Gradle JVM heap. Prebuild regenerates android/gradle.properties
// from the Expo template, which pins org.gradle.jvmargs to -Xmx2048m. D8 dexing this
// app (many native modules + RN 0.85) OOMs at 2 GB, so bump the heap here where it
// survives every prebuild. Value is generous but well within the build machines.

const { withGradleProperties } = require("expo/config-plugins");

const JVM_ARGS = "-Xmx6144m -XX:MaxMetaspaceSize=1024m -XX:+HeapDumpOnOutOfMemoryError";

module.exports = function withAndroidGradleHeap(config) {
  return withGradleProperties(config, (cfg) => {
    const key = "org.gradle.jvmargs";
    const existing = cfg.modResults.find(
      (entry) => entry.type === "property" && entry.key === key,
    );
    if (existing) {
      existing.value = JVM_ARGS;
    } else {
      cfg.modResults.push({ type: "property", key, value: JVM_ARGS });
    }
    return cfg;
  });
};
