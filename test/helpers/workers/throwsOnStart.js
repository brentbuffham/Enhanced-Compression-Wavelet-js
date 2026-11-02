// test/helpers/workers/throwsOnStart.js
// A pool worker entry that fails before it is ready (a blocked or broken script).
throw new Error("this worker never starts");
