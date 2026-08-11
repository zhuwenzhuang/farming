---
description: Configure Farming Code appearance, Agent behavior, search, Farming Pet, and updates.
---

# Settings

Settings manages appearance, Agent behavior, search, Farming Pet, and updates. Options appear only when supported by the current installation and runtime.

<ThemeImage light="/cn/assets/settings.png" dark="/cn/assets/settings-dark.png" alt="Farming Settings" />

> Documentation screenshots use the English product interface so automated captures remain stable. You can switch the product UI language at the top of Settings.

## Appearance and language

Choose system, light, dark, or Paper appearance and switch the product interface between Chinese and English. Paper uses warm low-glare surfaces, ink-like text, and restrained green accents for sustained reading.

## Interface

**Interface skin** switches between Farming Code and Farming CRT. Both connect to the same backend Sessions and do not stop Agents during a switch.

**Content font size** changes primary reading content in Chat, Terminal, Markdown, and the file editor without scaling navigation and status controls equally. Code and CRT store separate content-size preferences.

## Agent

**Follow-up behavior** decides whether a message sent while an Agent is working waits in a queue or immediately redirects the current work.

Completion notifications request browser permission only after explicit opt-in. Reloading or reconnecting does not replay old completion events.

**Skip permissions by default** relaxes default confirmation for new Agents. Use it only for trusted Workspaces and tasks; Providers may still enforce their own permission model.

## Search

**Search timeout** limits how long a search waits. In large repositories, narrow paths and queries before increasing the timeout.

## Farming Pet

Farming Pet is an optional focus-timer-style rest reminder. Choose an interval and one of two rest scenes:

- **Soft glow**: a quiet frosted-light screen;
- **Black hole**: a full-screen animated black hole.

It measures foreground use of the current Farming tab and does not pause or alter Agent work.

### Soft glow

<ThemeImage light="/cn/assets/pet-soft-glow.png" dark="/cn/assets/pet-soft-glow-dark.png" alt="Farming Pet soft-glow rest screen" />

### Black hole

![Farming Pet black-hole rest screen](/cn/assets/pet-black-hole.png)

## Updates

npm installations can check and prepare releases under Updates. The panel shows current version, target version, installation source, and explicit results.
