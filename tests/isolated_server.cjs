async function isolatedServer() {
  const configured = process.env.HANDBOOK_TEST_URL;
  if (!configured) {
    console.log("SKIP: set HANDBOOK_TEST_URL to an isolated handbook test server.");
    return null;
  }
  const url = new URL(configured);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      !url.port || url.port === "43127" || url.origin + "/" !== url.href) {
    throw new Error("HANDBOOK_TEST_URL must be a loopback origin on a dedicated test port.");
  }
  const response = await fetch(`${url.origin}/api/health`, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok || (await response.json()).features?.isolated_regression !== 1) {
    throw new Error("The server must use ANIME_HANDBOOK_SANDBOX=1 and a separate test data directory.");
  }
  return url.origin;
}

module.exports = { isolatedServer };
