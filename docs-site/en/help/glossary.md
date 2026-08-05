# Glossary

Farming keeps several English product and development terms so they match the interface, CLI, and Provider documentation.

## Agent

A coding Agent or Shell Session that performs work. Every Agent has an exact identity, state, and Workspace boundary.

## Project

A Farming work group organized around one repository. It keeps Agents, Files, and Resources in the right context.

## Workspace

The actual working directory an Agent may access. File reads, Browser transfers, and some Resource operations are bounded by it.

## Host

The development machine that runs Farming, coding CLIs, Agent processes, and Project files. The browser is only an interface connected to the Host.

## Provider

A coding Agent runtime or CLI such as Codex, Claude Code, or OpenCode. It owns authentication, models, and Session capabilities.

## Session

A persistent or resumable Agent interaction. Closing the browser does not end it; resume support depends on Provider and Session type.

## Resource

An external capability instance owned by an Agent and Project, such as Browser or experimental Computer. Resources have independent lifecycle and isolation boundaries.

## Owner

The authoritative identity that owns state or a Resource. Farming checks exact ownership before stop, delete, and recovery operations.

## Snapshot

A structured observation of a Browser page at one moment. Element references can become stale after page changes.

## PTY

Pseudo Terminal. Farming Terminal uses a PTY to connect real shells and coding CLIs while preserving interactive input, dimensions, and output.
