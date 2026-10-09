# 🐦 early-bird

**Make Claude's 5-hour usage limit reset when _you_ want it to.**

Your 5-hour usage window starts with your first message. Start work at 10:30
and it resets at 15:30, right in the middle of your busiest hours.

early-bird says a quick "Good morning." to Claude **five hours before the time
you pick**, even when Claude Code is closed. Pick `13:00` and the greeting goes
out at 08:00, so your window resets at 13:00, just when you need it.

## Install

In Claude Code, run:

```
/plugin install early-bird --marketplace pluckannfeel/early-bird
```

1. Answer `y` to add the marketplace.
2. Press Enter to install it for your user.
3. Set your **Reset time** (e.g. `13:00`), or keep the default.

That's it. Start a new session and early-bird sets up the timer for you. You'll
see a notice like:

```
early-bird: greeting at 08:00 (Mon, Tue, Wed, Thu, Fri) → window resets at 13:00
```

## Use

There's nothing to do day to day. While you work, the status line shows your
window:

```
5h 42% · resets in 2h14m
```

### Change it any time with `/usage-window`

| Command                  | What it does                                       |
| ------------------------ | -------------------------------------------------- |
| `/usage-window`          | Show the timer, the next greeting and your window  |
| `/usage-window 12:00`    | Make your window reset at 12:00 (24-hour, local)   |
| `/usage-window daily`    | Greet every day                                    |
| `/usage-window weekdays` | Greet Monday to Friday (the default)               |
| `/usage-window off`      | Remove the timer                                   |
| `/usage-window on`       | Put the timer back                                 |

Changes apply right away and stick across sessions. For example:

```
> /usage-window 12:00
early-bird: greeting at 07:00 (Mon, Tue, Wed, Thu, Fri) → window resets at 12:00
```

## Settings (optional)

You can also set the starting values in `~/.claude/settings.json`. Anything you
change with `/usage-window` takes priority over these.

```json
"pluginConfigs": {
  "early-bird": {
    "options": {
      "resetTime": "13:00",
      "days": "weekdays",
      "timer": true
    }
  }
}
```

| Setting     | Default      | What it does                                   |
| ----------- | ------------ | ---------------------------------------------- |
| `resetTime` | `"13:00"`    | When your window should reset (24-hour, local) |
| `days`      | `"weekdays"` | `"weekdays"` (Mon–Fri) or `"daily"`            |
| `timer`     | `true`       | `false` removes the timer                      |

## Good to know

- **Works with Claude Code closed.** early-bird uses your computer's own
  scheduler: systemd on Linux, launchd on macOS, Task Scheduler on Windows.
- **Asleep at greeting time?** The greeting goes out as soon as your computer
  wakes.
- **The greeting is tiny,** but it is a real request and counts toward your
  usage.
- **Needs a Claude subscription** (Pro or Max). API-key users don't have a
  5-hour window.

## Uninstall

1. Run `/usage-window off`. This removes the timer.
2. Uninstall the plugin with `/plugin`.

<details>
<summary>Uninstalled first? Remove the timer by hand.</summary>

```sh
# Linux
systemctl --user disable --now claude-usage-reset.timer
rm ~/.config/systemd/user/claude-usage-reset.{timer,service}

# macOS
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/local.claude-usage-reset.plist
rm ~/Library/LaunchAgents/local.claude-usage-reset.plist
```

```powershell
# Windows (PowerShell)
Unregister-ScheduledTask -TaskName 'Claude usage reset' -Confirm:$false
```

</details>
