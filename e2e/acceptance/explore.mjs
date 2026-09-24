// Manual exploration: node acceptance/explore.mjs <register> [--fresh]
// Launches the register, prints the screen text and saves a screenshot.
import { cloudEnv, startRegister } from "./harness.mjs";

const name = process.argv[2] ?? "A";
const reg = await startRegister(name, { fresh: process.argv.includes("--fresh"), env: cloudEnv() });
try {
  await reg.browser.pause(4000);
  console.log((await reg.text()).slice(0, 2500));
  console.log("SHOT", await reg.shot("explore"));
} finally {
  await reg.stop();
}
