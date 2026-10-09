// early-bird: line up the 5-hour usage window with the workday.
//
// A plugin only runs while a session is open, so it does not send the
// greeting itself: at session start it installs (or updates, or removes) an
// OS timer that does, and while you work it shows the live window in the
// status line.

import type { EngineInterface, Register, Timer } from "claude-code";

import {
  LAUNCHD_LABEL,
  NAME,
  countdown,
  describe,
  launchdPlist,
  schedule,
  systemdService,
  systemdTimer,
  windowsNextRun,
  windowsRegister,
  windowsUnregister,
} from "./schedule.ts";
import type { Days, Platform, Schedule } from "./schedule.ts";

type $ = EngineInterface;

type Config = { resetText: string; isOn: boolean; wanted: Schedule | null };

// Bump when the timer files change shape, so existing installs are rewritten.
const FORMAT = 1;

export const register: Register = (on, options) => {
  const resetText = String(options.resetTime ?? "13:00");
  const days: Days = options.days === "daily" ? "daily" : "weekdays";
  const isOn = options.timer !== false;
  const wanted = schedule(resetText, days);

  let platform: Platform | undefined;
  let problem: string | undefined;
  let tick: Timer | undefined;

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await $.command.register({
      name: "usage-window",
      description: "Show the early-bird timer and the current 5-hour window",
    });
    if (!e.isInteractive) return result;

    try {
      platform = await detect($);
      await reconcile($, platform, { resetText, isOn, wanted });
      problem = undefined;
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
      $.ui.toast(`early-bird: ${problem}`);
    }
    await showWindow($);
    tick ??= $.clock.every(60_000, () => void showWindow($));
    return result;
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    await showWindow($);
    return result;
  });

  on("command.run", { command: "usage-window" }, async ($) => {
    platform ??= await detect($);
    const lines = ["early-bird"];
    if (problem) {
      lines.push(`  Timer: not set up: ${problem}`);
    } else if (!isOn || !wanted) {
      lines.push("  Timer: off");
    } else {
      lines.push(`  Timer: on (${MANAGER[platform]}): ${describe(wanted)}`);
      const nextRun = await nextGreeting($, platform);
      if (nextRun) lines.push(`  Next greeting: ${nextRun}`);
    }
    const window = await fiveHour($);
    lines.push(
      window
        ? `  Now: ${window.used}% of the 5-hour window used${window.left ? `, resets in ${window.left}` : ""}`
        : "  Now: no 5-hour window reported (an API key, or no request yet)",
    );
    lines.push("  Change the time, the days or turn the timer off in /config.");
    return { text: lines.join("\n") };
  });
};

// Install, update or remove the timer so it matches the options. The key
// in $.store says what was last installed, so an unchanged setup costs one
// file check per session.
async function reconcile($: $, platform: Platform, cfg: Config) {
  const { resetText, isOn, wanted } = cfg;
  if (isOn && !wanted) {
    throw new Error(`reset time "${resetText}" is not HH:MM (24-hour)`);
  }
  const key = isOn && wanted ? `${FORMAT}|${platform}|${describe(wanted)}` : "off";
  const applied = await $.store.get("applied");
  if (applied === key && (key === "off" || (await isInstalled($, platform)))) {
    return;
  }
  if (key === "off" || !wanted) {
    if (applied !== undefined) await uninstall($, platform);
    await $.store.set("applied", "off");
    if (applied !== undefined) $.ui.toast("early-bird: timer removed");
    return;
  }
  await install($, platform, wanted);
  await $.store.set("applied", key);
  $.ui.toast(`early-bird: ${describe(wanted)}`);
}

const MANAGER: Record<Platform, string> = {
  linux: "systemd",
  macos: "launchd",
  windows: "Task Scheduler",
};

async function detect($: $): Promise<Platform> {
  if ((await $.env.get("OS")) === "Windows_NT") return "windows";
  const uname = await $.process.run(["uname", "-s"]);
  return uname.stdout.trim() === "Darwin" ? "macos" : "linux";
}

async function run($: $, argv: string[]): Promise<string> {
  const r = await $.process.run(argv, { timeoutMs: 60_000 });
  if (r.exitCode !== 0) {
    const why = (r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.exitCode}`;
    throw new Error(`${argv.slice(0, 3).join(" ")} failed: ${why}`);
  }
  return r.stdout;
}

const powershell = (script: string) => [
  "powershell.exe",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  script,
];

async function claudePath($: $, platform: Platform): Promise<string> {
  if (platform === "windows") {
    const found = (await run($, ["where.exe", "claude"])).split(/\r?\n/).map((l) => l.trim());
    const exe = found.find((l) => /\.(exe|cmd)$/i.test(l)) ?? found[0];
    if (!exe) throw new Error("claude is not on PATH");
    return exe;
  }
  const found = (await run($, ["sh", "-c", "command -v claude"])).trim();
  if (!found) throw new Error("claude is not on PATH");
  return found;
}

async function home($: $): Promise<string> {
  const dir = await $.env.get("HOME");
  if (!dir) throw new Error("HOME is not set");
  return dir;
}

async function systemdDir($: $): Promise<string> {
  const config = (await $.env.get("XDG_CONFIG_HOME")) ?? `${await home($)}/.config`;
  return `${config}/systemd/user`;
}

async function plistPath($: $): Promise<string> {
  return `${await home($)}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
}

async function isInstalled($: $, platform: Platform): Promise<boolean> {
  if (platform === "linux") return $.fs.exists(`${await systemdDir($)}/${NAME}.timer`);
  if (platform === "macos") return $.fs.exists(await plistPath($));
  return true; // Task Scheduler: trust what was last registered
}

async function install($: $, platform: Platform, s: Schedule) {
  const claude = await claudePath($, platform);
  const path = (await $.env.get("PATH")) ?? "/usr/local/bin:/usr/bin:/bin";

  if (platform === "linux") {
    const dir = await systemdDir($);
    await run($, ["mkdir", "-p", dir]);
    await $.fs.write(`${dir}/${NAME}.service`, systemdService(claude, path));
    await $.fs.write(`${dir}/${NAME}.timer`, systemdTimer(s));
    await run($, ["systemctl", "--user", "daemon-reload"]);
    await run($, ["systemctl", "--user", "enable", `${NAME}.timer`]);
    await run($, ["systemctl", "--user", "restart", `${NAME}.timer`]);
  } else if (platform === "macos") {
    const plist = await plistPath($);
    const domain = `gui/${(await run($, ["id", "-u"])).trim()}`;
    await run($, ["mkdir", "-p", plist.slice(0, plist.lastIndexOf("/"))]);
    await $.fs.write(plist, launchdPlist(s, claude, path));
    await $.process.run(["launchctl", "bootout", domain, plist]); // not loaded yet is fine
    await run($, ["launchctl", "bootstrap", domain, plist]);
  } else {
    await run($, powershell(windowsRegister(s, claude)));
  }
}

async function uninstall($: $, platform: Platform) {
  if (platform === "linux") {
    const dir = await systemdDir($);
    await $.process.run(["systemctl", "--user", "disable", "--now", `${NAME}.timer`]);
    await run($, ["rm", "-f", `${dir}/${NAME}.timer`, `${dir}/${NAME}.service`]);
    await run($, ["systemctl", "--user", "daemon-reload"]);
  } else if (platform === "macos") {
    const plist = await plistPath($);
    const domain = `gui/${(await run($, ["id", "-u"])).trim()}`;
    await $.process.run(["launchctl", "bootout", domain, plist]);
    await run($, ["rm", "-f", plist]);
  } else {
    await run($, powershell(windowsUnregister()));
  }
}

async function nextGreeting($: $, platform: Platform): Promise<string | undefined> {
  const argv =
    platform === "linux"
      ? ["systemctl", "--user", "show", `${NAME}.timer`, "-p", "NextElapseUSecRealtime", "--value"]
      : platform === "windows"
        ? powershell(windowsNextRun())
        : undefined; // launchd does not say when a calendar job runs next
  if (!argv) return undefined;
  const r = await $.process.run(argv);
  return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

async function fiveHour($: $): Promise<{ used: number; left?: string } | undefined> {
  const { rateLimits } = await $.session.usage();
  const window = rateLimits.find((r) => r.kind === "five_hour");
  if (!window) return undefined;
  const ms = window.resetsAt ? Date.parse(window.resetsAt) - (await $.clock.now()) : NaN;
  return { used: Math.round(window.percentUsed), left: ms > 0 ? countdown(ms) : undefined };
}

async function showWindow($: $) {
  const window = await fiveHour($);
  $.ui.status(
    window ? `5h ${window.used}%${window.left ? ` · resets in ${window.left}` : ""}` : undefined,
  );
}
