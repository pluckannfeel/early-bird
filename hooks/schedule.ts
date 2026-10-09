// Pure scheduling: from the reset time a person wants to the OS timer that
// sends the greeting 5 hours earlier. No I/O here, so it tests on its own.

export const WINDOW_HOURS = 5;
export const NAME = "claude-usage-reset";
export const LAUNCHD_LABEL = "local.claude-usage-reset";
export const WINDOWS_TASK = "Claude usage reset";

// The smallest request that opens a usage window.
export const GREETING = [
  "--print",
  "--no-session-persistence",
  "--safe-mode",
  "--effort",
  "low",
  "--tools",
  "",
  "--system-prompt",
  "Reply with OK.",
  "Good morning.",
];

export type Platform = "linux" | "macos" | "windows";
export type Days = "weekdays" | "daily";

export type Schedule = {
  reset: string; // HH:MM, as configured
  hour: number; // when the greeting goes out
  minute: number;
  weekdays: number[] | null; // 0 = Sunday; null = every day
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function parseTime(text: string): { hour: number; minute: number } | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

const pad = (n: number) => String(n).padStart(2, "0");
export const clock = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;

// The greeting goes out WINDOW_HOURS before the reset. A reset before 05:00
// means the greeting falls on the previous day, so the days move back too:
// a 03:00 reset on weekdays is a 22:00 greeting Sunday to Thursday.
export function schedule(reset: string, days: Days): Schedule | null {
  const time = parseTime(reset);
  if (!time) return null;
  const shifted = time.hour - WINDOW_HOURS;
  const hour = (shifted + 24) % 24;
  const back = shifted < 0 ? 1 : 0;
  const weekdays =
    days === "daily" ? null : [1, 2, 3, 4, 5].map((d) => (d - back + 7) % 7).sort((a, b) => a - b);
  return { reset: clock(time.hour, time.minute), hour, minute: time.minute, weekdays };
}

export function describe(s: Schedule): string {
  const when = s.weekdays ? s.weekdays.map((d) => DAY_NAMES[d]).join(", ") : "every day";
  return `greeting at ${clock(s.hour, s.minute)} (${when}) → window resets at ${s.reset}`;
}

// --- Linux: a systemd user timer -------------------------------------------

const systemdQuote = (arg: string) =>
  `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function systemdService(claude: string, path: string): string {
  return `[Unit]
Description=Open the Claude usage window (early-bird plugin)

[Service]
Type=oneshot
WorkingDirectory=%t
Environment=${systemdQuote(`PATH=${path}`)}
ExecStart=${[claude, ...GREETING].map(systemdQuote).join(" ")}
`;
}

export function systemdTimer(s: Schedule): string {
  const days = s.weekdays ? `${s.weekdays.map((d) => DAY_NAMES[d]).join(",")} ` : "";
  return `[Unit]
Description=${describe(s)}

[Timer]
OnCalendar=${days}*-*-* ${clock(s.hour, s.minute)}:00
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
`;
}

// --- macOS: a launchd agent --------------------------------------------------

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(s: Schedule, claude: string, path: string): string {
  const at = (day?: number) =>
    `    <dict>${day === undefined ? "" : `<key>Weekday</key><integer>${day}</integer>`}` +
    `<key>Hour</key><integer>${s.hour}</integer>` +
    `<key>Minute</key><integer>${s.minute}</integer></dict>`;
  const intervals = s.weekdays ? s.weekdays.map(at) : [at()];
  const args = [claude, ...GREETING].map((a) => `    <string>${xml(a)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>WorkingDirectory</key><string>/tmp</string>
  <key>StartCalendarInterval</key>
  <array>
${intervals.join("\n")}
  </array>
</dict>
</plist>
`;
}

// --- Windows: a Task Scheduler task, made through PowerShell ----------------

const psQuote = (text: string) => `'${text.replace(/'/g, "''")}'`;
const winArg = (arg: string) => (arg === "" || /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

export function windowsRegister(s: Schedule, claude: string): string {
  const trigger = s.weekdays
    ? `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${s.weekdays.map((d) => DAY_LONG[d]).join(",")} -At ${clock(s.hour, s.minute)}`
    : `New-ScheduledTaskTrigger -Daily -At ${clock(s.hour, s.minute)}`;
  return [
    `$action = New-ScheduledTaskAction -Execute ${psQuote(claude)} -Argument ${psQuote(GREETING.map(winArg).join(" "))} -WorkingDirectory $env:TEMP`,
    `$trigger = ${trigger}`,
    `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable`,
    `Register-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK)} -Description ${psQuote(describe(s))} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
  ].join("; ");
}

export const windowsUnregister = () =>
  `Unregister-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK)} -Confirm:$false -ErrorAction SilentlyContinue`;

export const windowsNextRun = () =>
  `$i = Get-ScheduledTaskInfo -TaskName ${psQuote(WINDOWS_TASK)} -ErrorAction SilentlyContinue; if ($i) { $i.NextRunTime.ToString('ddd yyyy-MM-dd HH:mm') }`;

// --- The live window ---------------------------------------------------------

export function countdown(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h${pad(m)}m` : `${m}m`;
}
