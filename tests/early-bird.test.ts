import { describe, expect, mock, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On, ProcessRunResult, SessionRateLimit } from "claude-code";

import { schedule } from "../hooks/schedule.ts";

const NOW = Date.parse("2026-10-12T00:00:00Z");
const SYSTEMD = "/home/u/.config/systemd/user/claude-usage-reset";
const PLIST = "/Users/u/Library/LaunchAgents/local.claude-usage-reset.plist";

type Os = "Linux" | "Darwin" | "Windows";

// The machine beneath the plugin: an OS, its files, its processes, the
// account's usage. Records what the plugin did to it.
function machine(on: On, os: Os = "Linux", stored: Record<string, unknown> = {}) {
  const world = {
    runs: [] as string[][],
    writes: {} as Record<string, string>,
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    fiveHour: { kind: "five_hour", percentUsed: 42, resetsAt: iso(2 * 60 + 14) } as
      | SessionRateLimit
      | undefined,
    clock: undefined as unknown as ReturnType<typeof mock.clock>,
    ran: (prefix: string) => world.runs.some((argv) => argv.join(" ").startsWith(prefix)),
  };

  mock.env(
    on,
    os === "Windows"
      ? { OS: "Windows_NT", PATH: "C:\\bin" }
      : { HOME: os === "Darwin" ? "/Users/u" : "/home/u", PATH: "/usr/bin:/bin" },
  );
  mock.store(on, stored);
  const clock = mock.clock(on, { now: NOW });

  world.clock = clock;

  on("process.run", async (_$, e) => {
    world.runs.push([...e.argv]);
    return { value: answer(e.argv, os) };
  });
  on("fs.write", async (_$, e) => {
    world.writes[e.path] = e.text;
    return { value: undefined };
  });
  on("fs.exists", async (_$, e) => ({ value: e.path in world.writes }));
  on("ui.status", async (_$, e) => {
    world.statuses.push(e.text);
    return { value: undefined };
  });
  on("ui.toast", async (_$, e) => {
    world.toasts.push(e.text);
    return { value: undefined };
  });
  on("command.register", async (_$, e) => ({ value: { command: e.name } }));
  on("session.usage", async () => ({
    value: {
      startedAt: NOW,
      context: { window: 200_000 },
      rateLimits: world.fiveHour ? [world.fiveHour] : [],
    },
  }));
  on("session.start", async (_$, e) => ({ cwd: e.cwd }));
  on("turn.complete", async () => ({ text: "" }));
  return world;
}

function iso(minutesFromNow: number) {
  return new Date(NOW + minutesFromNow * 60_000).toISOString();
}

function answer(argv: readonly string[], os: Os): ProcessRunResult {
  const line = argv.join(" ");
  const out = (stdout: string, exitCode = 0): ProcessRunResult => ({
    exitCode,
    stdout,
    stderr: "",
    isStdoutTruncated: false,
    isStderrTruncated: false,
  });
  if (line === "uname -s") return out(os === "Darwin" ? "Darwin\n" : "Linux\n");
  if (line === "sh -c command -v claude") return out("/usr/bin/claude\n");
  if (line === "where.exe claude") return out("C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\n");
  if (line === "id -u") return out("501\n");
  if (line.includes("NextElapseUSecRealtime")) return out("Mon 2026-10-12 08:00:00 JST\n");
  return out("");
}

const start = ($: Engine, isInteractive = true) =>
  $.session.start({ cwd: "/", surface: "terminal", isInteractive });

const usageWindow = async ($: Engine, args = "") =>
  (
    await $.command.run({
      command: "usage-window",
      args,
      origin: { kind: "composer" },
      presentation: { isFullscreen: false, columns: 100 },
    })
  ).text ?? "";

describe("schedule", () => {
  test("greets five hours before the reset, on weekdays", () => {
    expect(schedule("13:00", "weekdays")).toEqual({
      reset: "13:00",
      hour: 8,
      minute: 0,
      weekdays: [1, 2, 3, 4, 5],
    });
  });

  test("moves the days back when the greeting falls the evening before", () => {
    expect(schedule("3:30", "weekdays")).toEqual({
      reset: "03:30",
      hour: 22,
      minute: 30,
      weekdays: [0, 1, 2, 3, 4],
    });
    expect(schedule("03:30", "daily")?.weekdays).toBeNull();
  });

  test("refuses what is not a 24-hour time", () => {
    expect(schedule("1pm", "weekdays")).toBeNull();
    expect(schedule("24:00", "weekdays")).toBeNull();
    expect(schedule("12:60", "weekdays")).toBeNull();
  });
});

describe("timer", () => {
  test("installs a systemd user timer on Linux", async ($, on) => {
    const world = machine(on);
    await start($);

    const timer = world.writes[`${SYSTEMD}.timer`];
    const service = world.writes[`${SYSTEMD}.service`];
    expect(timer).toContain("OnCalendar=Mon,Tue,Wed,Thu,Fri *-*-* 08:00:00");
    expect(timer).toContain("Persistent=true");
    expect(service).toContain('ExecStart="/usr/bin/claude" "--print"');
    expect(service).toContain('"--tools" ""');
    expect(service).toContain('Environment="PATH=/usr/bin:/bin"');
    expect(world.ran("systemctl --user enable claude-usage-reset.timer")).toBe(true);
    expect(world.ran("systemctl --user restart claude-usage-reset.timer")).toBe(true);
    expect(world.toasts).toContain(
      "early-bird: greeting at 08:00 (Mon, Tue, Wed, Thu, Fri) → window resets at 13:00",
    );
  });

  test("leaves an unchanged timer alone", async ($, on) => {
    const world = machine(on);
    await start($);
    const runs = world.runs.length;
    await start($);
    expect(world.runs.slice(runs).some((argv) => argv[0] === "systemctl")).toBe(false);
    expect(world.toasts).toHaveLength(1);
  });

  test(
    "follows the configured time and days",
    { options: { resetTime: "09:30", days: "daily" } },
    async ($, on) => {
      const world = machine(on);
      await start($);
      expect(world.writes[`${SYSTEMD}.timer`]).toContain("OnCalendar=*-*-* 04:30:00");
    },
  );

  test("installs a launchd agent on macOS", async ($, on) => {
    const world = machine(on, "Darwin");
    await start($);
    const plist = world.writes[PLIST];
    expect(plist).toContain("<string>/usr/bin/claude</string>");
    expect(plist).toContain(
      "<dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>8</integer>",
    );
    expect(world.ran(`launchctl bootstrap gui/501 ${PLIST}`)).toBe(true);
  });

  test("registers a scheduled task on Windows", async ($, on) => {
    const world = machine(on, "Windows");
    await start($);
    const ps = world.runs.find((argv) => argv[0] === "powershell.exe")?.at(-1) ?? "";
    expect(ps).toContain("-Execute 'C:\\npm\\claude.cmd'");
    expect(ps).toContain(
      "-Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 08:00",
    );
    expect(ps).toContain("-StartWhenAvailable");
    expect(ps).toContain('--tools ""');
    expect(world.ran("uname")).toBe(false);
  });

  test("removes the timer when it is turned off", { options: { timer: false } }, async ($, on) => {
    const world = machine(on, "Linux", { applied: "1|linux|old" });
    await start($);
    expect(world.ran("systemctl --user disable --now claude-usage-reset.timer")).toBe(true);
    expect(world.ran(`rm -f ${SYSTEMD}.timer ${SYSTEMD}.service`)).toBe(true);
    expect(world.toasts).toContain("early-bird: timer removed");
  });

  test("does nothing when off and never installed", { options: { timer: false } }, async ($, on) => {
    const world = machine(on);
    await start($);
    expect(world.ran("systemctl")).toBe(false);
    expect(world.toasts).toHaveLength(0);
  });

  test("says what is wrong with a bad time", { options: { resetTime: "1pm" } }, async ($, on) => {
    const world = machine(on);
    await start($);
    expect(Object.keys(world.writes)).toHaveLength(0);
    expect(world.toasts[0]).toContain('reset time "1pm" is not HH:MM');
    expect(await usageWindow($)).toContain("Timer: not set up");
  });

  test("leaves the machine alone in a non-interactive run", async ($, on) => {
    const world = machine(on);
    await start($, false);
    expect(world.runs).toHaveLength(0);
    expect(world.statuses).toHaveLength(0);
  });
});

describe("status line", () => {
  test("shows the live 5-hour window and keeps it ticking", async ($, on) => {
    const world = machine(on);
    await start($);
    expect(world.statuses.at(-1)).toBe("5h 42% · resets in 2h14m");

    world.fiveHour = { kind: "five_hour", percentUsed: 57, resetsAt: iso(2 * 60 + 14) };
    await world.clock.advance(60_000);
    expect(world.statuses.at(-1)).toBe("5h 57% · resets in 2h13m");
  });

  test("clears itself where no 5-hour window is reported", async ($, on) => {
    const world = machine(on);
    world.fiveHour = undefined;
    await start($);
    expect(world.statuses.at(-1)).toBeUndefined();
  });
});

describe("/usage-window", () => {
  test("shows the timer, the next greeting and the window", async ($, on) => {
    machine(on);
    await start($);
    const text = await usageWindow($);
    expect(text).toContain(
      "Timer: on (systemd): greeting at 08:00 (Mon, Tue, Wed, Thu, Fri) → window resets at 13:00",
    );
    expect(text).toContain("Next greeting: Mon 2026-10-12 08:00:00 JST");
    expect(text).toContain("Now: 42% of the 5-hour window used, resets in 2h14m");
  });

  test("moves the reset time and rewrites the timer at once", async ($, on) => {
    const world = machine(on);
    await start($);
    const text = await usageWindow($, "12:00");
    expect(text).toStartWith(
      "early-bird: greeting at 07:00 (Mon, Tue, Wed, Thu, Fri) → window resets at 12:00",
    );
    expect(world.writes[`${SYSTEMD}.timer`]).toContain("Mon,Tue,Wed,Thu,Fri *-*-* 07:00:00");
  });

  test("keeps its changes in later sessions", async ($, on) => {
    const world = machine(on);
    await start($);
    await usageWindow($, "9:15");
    await usageWindow($, "daily");
    const runs = world.runs.length;
    await start($);
    expect(world.writes[`${SYSTEMD}.timer`]).toContain("OnCalendar=*-*-* 04:15:00");
    expect(world.runs.slice(runs).some((argv) => argv[0] === "systemctl")).toBe(false);
  });

  test("wins over the plugin's options", { options: { resetTime: "10:00" } }, async ($, on) => {
    const world = machine(on);
    await start($);
    expect(world.writes[`${SYSTEMD}.timer`]).toContain("05:00:00");
    await usageWindow($, "14:00");
    expect(world.writes[`${SYSTEMD}.timer`]).toContain("09:00:00");
  });

  test("turns the timer off and back on", async ($, on) => {
    const world = machine(on);
    await start($);
    expect(await usageWindow($, "off")).toStartWith("early-bird: timer removed");
    expect(world.ran("systemctl --user disable --now claude-usage-reset.timer")).toBe(true);
    expect(await usageWindow($)).toContain("Timer: off");
    expect(await usageWindow($, "ON")).toStartWith("early-bird: greeting at 08:00");
  });

  test("refuses a time that does not exist", async ($, on) => {
    const world = machine(on);
    await start($);
    const writes = Object.keys(world.writes).length;
    expect(await usageWindow($, "25:00")).toBe(
      'early-bird: "25:00" is not a 24-hour time (00:00 to 23:59)',
    );
    expect(Object.keys(world.writes)).toHaveLength(writes);
  });

  test("explains itself for anything else", async ($, on) => {
    machine(on);
    await start($);
    expect(await usageWindow($, "1pm")).toContain("/usage-window takes one of");
  });
});
