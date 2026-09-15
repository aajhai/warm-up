import { randomFloat, randomInt } from "./util/random.js";

function envBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const argv = process.argv.slice(2);
const cliForce = argv.includes("--force") || argv.includes("--test");

export const config = {
  profileName: process.env.GL_PROFILE_NAME || process.env.GOLOGIN_PROFILE_NAME || "Kunal Mittal",
  profileId: process.env.GL_PROFILE_ID || process.env.GOLOGIN_PROFILE_ID || "",
  gologinToken: process.env.GL_API_TOKEN || process.env.GOLOGIN_API_TOKEN || process.env.GL_TOKEN || "",
  browserMode: (process.env.GOLOGIN_BROWSER_MODE || "cloud").toLowerCase(),
  likesEnabled: envBool("LIKES_ENABLED", true),
  stopProfileAfterSession: envBool("STOP_PROFILE_AFTER_SESSION", true),
  forceOutsideHours: envBool("FORCE_OUTSIDE_HOURS", false) || cliForce || argv.includes("--outside-hours"),
  allowBlockedDay: envBool("ALLOW_BLOCKED_DAY", false) || argv.includes("--allow-blocked-day"),
  testRun: envBool("TEST_RUN", false) || cliForce,
  connectionTrial: argv.includes("--connection-trial"),
  feedUrl: "https://www.linkedin.com/feed/",
  timezone: "Asia/Kolkata",
  workStartHour: 9,
  workEndHour: 17,
  sessionMinutes: { min: 10, max: 20 },
  likeRate: { min: 0.02, max: 0.05 },
  likeCapPerSession: 3,
  dailyLikeBudget: 6,
  connectionsEnabled: envBool("CONNECTIONS_ENABLED", false),
  connectionWeeklyRanges: [[30, 50], [50, 70], [70, 80], [80, 100]],
  connectionBatchRange: [2, 4],
  connectionWeekReset: "Monday 00:00 UTC",
  forbidden: ["comment", "follow", "message", "dm", "repost", "share"],
};

export function sampleSessionPlan() {
  return {
    sessionMs: randomInt(config.sessionMinutes.min * 60_000, config.sessionMinutes.max * 60_000),
    likeRate: randomFloat(config.likeRate.min, config.likeRate.max),
    likeCap: config.likeCapPerSession,
    skipFirstPosts: randomInt(8, 14),
    warmupMs: randomInt(70_000, 110_000),
    windDownMs: randomInt(35_000, 55_000),
    minMsBetweenLikes: randomInt(95_000, 190_000),
    settleMs: randomInt(3500, 9000),
    glanceNotifications: Math.random() < 0.32,
    reverseScrollChance: 0.05,
    expandRate: randomFloat(0.30, 0.40),
    idleChance: randomFloat(0.05, 0.12),
  };
}
