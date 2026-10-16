// The decisions behind `ui --detach` and `ui-stop`, kept as pure functions so they can be tested without Docker.

// `status` is the exit code of `n8n-chamber.sh status`: 0 = clean, 1 = something is there, 2 = could not tell.
// Starting a chamber replaces any existing one, and with it any unsaved edits, so a start must refuse when
// something is there. When we cannot tell, the start goes ahead and reports its own problem.
export function startVerdict(status) {
  if (status === 1) {
    return {
      refuse: true,
      message: "A chamber is already running (or was left behind by a crash), so a new one was not started.\n" +
        "  To save its edits and remove it:  node harness/n8n-dev.mjs ui-stop\n" +
        "  To just remove it:                bash ./scripts/n8n-chamber.sh down",
    };
  }
  return { refuse: false };
}

// Did a stop that began at `began` (milliseconds) save anything? The export folder keeps the previous session's
// files, so only files written during this stop count. `files` is a list of { mtimeMs }.
export function savedSince(files, began, slackMs = 2000) {
  return files.some((f) => f.mtimeMs >= began - slackMs);
}
